/**
 * Re-embed transcripts with the current (turn-aware, speaker-labeled) chunker
 * and backfill identifier metadata.
 *
 * Originally a Phase 2 metadata-index migration; now also the home for the
 * v2 speaker-aware re-index. Per transcript it:
 *   1. Reads rows from D1 that have raw_text (optionally only stale ones)
 *   2. Re-chunks raw_text via the turn-aware embeddings.chunkTranscript,
 *      passing participant names so chunks split on speaker turns
 *   3. Regenerates embeddings via OpenAI (the ingest embedding seam)
 *   4. Upserts via wrangler vectorize upsert (NDJSON) — deterministic
 *      {transcriptId}-{chunkIndex} ids, so idempotent
 *   5. Tail-deletes surplus old vectors when the new chunk count is lower
 *   6. Backfills meeting_code + chunk_count + chunk_schema_version in D1
 *
 * Because steps 4–6 are deterministic + idempotent, the script is safe to
 * re-run and resumable (with --stale-only it skips already-v2 rows).
 *
 * Cost: ~$0.00002/1k tokens × ~500 tokens/chunk × ~20 chunks/call × N calls.
 * For 50 calls ≈ $0.01.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/reindex-vectorize.ts
 *   ... scripts/reindex-vectorize.ts --stale-only          # only rows below v2
 *   ... scripts/reindex-vectorize.ts --video-id=meet.google.com/xyz-abc
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import OpenAI from "openai";
import {
  chunkTranscript,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  CHUNK_SCHEMA_VERSION,
} from "../src/embeddings";
import { tailDeleteIds } from "../src/vectorize";
import { resolveMeetingCode } from "../src/identity";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const D1_NAME = "aftercall-db";
const VECTORIZE_NAME = "aftercall-vectors";
const METADATA_TEXT_MAX = 2048;
const TAIL_DELETE_PAD = 64;
const staleOnly = process.argv.includes("--stale-only");

if (!OPENAI_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const videoIdFilter = process.argv.find((a) => a.startsWith("--video-id="))?.split("=")[1];
const openai = new OpenAI({ apiKey: OPENAI_KEY });

interface TranscriptRow {
  id: number;
  video_id: string;
  title: string;
  raw_text: string | null;
  participants: string | null;
}

function runCli(cmd: string, args: string[], input?: string): { stdout: string; status: number } {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 50 * 1024 * 1024 });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

function sqlExec(command: string): { stdout: string; status: number } {
  return runCli("npx", [
    "wrangler",
    "d1",
    "execute",
    D1_NAME,
    "--remote",
    "--command",
    command,
    "--json",
  ]);
}

function listTranscripts(): TranscriptRow[] {
  const conditions = ["raw_text IS NOT NULL"];
  if (videoIdFilter) conditions.push(`video_id = '${videoIdFilter.replace(/'/g, "''")}'`);
  if (staleOnly) {
    conditions.push(`(chunk_schema_version IS NULL OR chunk_schema_version < ${CHUNK_SCHEMA_VERSION})`);
  }
  const r = sqlExec(
    `SELECT id, video_id, title, raw_text, participants FROM transcripts WHERE ${conditions.join(" AND ")}`,
  );
  if (r.status !== 0) {
    console.error("Failed to query D1:", r.stdout);
    process.exit(1);
  }
  const parsed = JSON.parse(r.stdout);
  return parsed[0]?.results ?? [];
}

function speakersFrom(participantsJson: string | null): string[] {
  if (!participantsJson) return [];
  try {
    const parsed = JSON.parse(participantsJson) as Array<{ name?: string; email?: string }>;
    return parsed
      .map((p) => p.name ?? p.email)
      .filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

async function reindexOne(row: TranscriptRow): Promise<number> {
  if (!row.raw_text) return 0;

  const speakers = speakersFrom(row.participants);
  const chunks = chunkTranscript(row.raw_text, { maxTokens: 500, overlapTokens: 50, speakers });
  if (chunks.length === 0) return 0;

  console.log(`  Embedding ${chunks.length} turn-aware chunk(s)...`);
  const embResp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: chunks.map((c) => c.text),
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const vectors = embResp.data.map((d, i) => ({
    id: `${row.id}-${i}`,
    values: d.embedding,
    metadata: {
      transcript_id: row.id,
      chunk_index: i,
      chunk_text: chunks[i].text.slice(0, METADATA_TEXT_MAX),
    },
  }));

  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
  const tmpFile = `/tmp/reindex-${row.id}.ndjson`;
  writeFileSync(tmpFile, ndjson);
  const ins = runCli("npx", ["wrangler", "vectorize", "upsert", VECTORIZE_NAME, "--file", tmpFile]);
  unlinkSync(tmpFile);
  if (ins.status !== 0) {
    console.error(`  ✗ wrangler vectorize upsert failed:`, ins.stdout);
    return 0;
  }

  // Tail-delete stale vectors from a previously-larger chunking (no-op if none).
  const staleIds = tailDeleteIds(row.id, vectors.length, TAIL_DELETE_PAD);
  runCli("npx", ["wrangler", "vectorize", "delete-vectors", VECTORIZE_NAME, "--ids", ...staleIds]);

  // Backfill identifier + chunk metadata in D1 (folds in the meeting_code backfill).
  const code = resolveMeetingCode(row.video_id);
  const codeSql = code ? `'${code.replace(/'/g, "''")}'` : "NULL";
  sqlExec(
    `UPDATE transcripts SET meeting_code = ${codeSql}, chunk_count = ${vectors.length}, ` +
      `chunk_schema_version = ${CHUNK_SCHEMA_VERSION} WHERE id = ${row.id}`,
  );

  console.log(`  ✓ ${vectors.length} vector(s) upserted + metadata backfilled for transcript ${row.id}`);
  return vectors.length;
}

async function main(): Promise<void> {
  const rows = listTranscripts();
  console.log(`Found ${rows.length} transcript row(s)${videoIdFilter ? ` matching \`${videoIdFilter}\`` : ""}`);

  let totalVectors = 0;
  let failures = 0;
  for (const row of rows) {
    console.log(`\n→ [${row.id}] ${row.title.slice(0, 60)} (${row.video_id})`);
    try {
      totalVectors += await reindexOne(row);
    } catch (err) {
      failures++;
      console.error(`  ✗ Failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n--- Done ---`);
  console.log(`  Transcripts processed: ${rows.length}`);
  console.log(`  Total vectors upserted: ${totalVectors}`);
  console.log(`  Failures: ${failures}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
