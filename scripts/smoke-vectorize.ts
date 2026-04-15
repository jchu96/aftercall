/**
 * Smoke test for Vectorize: upsert a few vectors, query nearest with
 * retry/backoff (Vectorize is async-eventual — immediate query may miss).
 *
 * Run: npx wrangler dev --test scripts/smoke-vectorize.ts (manual)
 *  or: invoke this from a temporary worker route during dev
 *
 * For Phase 2 verification, we run this against the dev Vectorize index
 * via a one-off Worker route — see scripts/smoke.ts.
 */
import { upsertChunkEmbeddings, vectorIdFor, type EmbeddedChunk } from "../src/vectorize";

const TRANSCRIPT_ID = 9999;
const CHUNKS = 3;
const MAX_RETRIES = 8;
const RETRY_BASE_MS = 250;

export async function smokeTest(index: VectorizeIndex): Promise<{ ok: boolean; details: string }> {
  // Build deterministic embeddings (sin curve so each chunk is distinct)
  const chunks: EmbeddedChunk[] = Array.from({ length: CHUNKS }, (_, i) => ({
    transcriptId: TRANSCRIPT_ID,
    chunkIndex: i,
    text: `smoke chunk ${i}`,
    embedding: new Array(1536).fill(0).map((_, j) => Math.sin((i * 1536 + j) / 100)),
  }));

  await upsertChunkEmbeddings(index, chunks);

  const expectedIds = [0, 1, 2].map((i) => vectorIdFor(TRANSCRIPT_ID, i));

  // getByIds is read-after-write consistent (key lookup, no index rebuild
  // delay) — better than query() for verifying the upsert landed.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    const fetched = await index.getByIds(expectedIds);
    if (fetched.length === expectedIds.length) {
      return {
        ok: true,
        details: `Round-trip succeeded on attempt ${attempt + 1}. Got ${fetched.length} vectors back.`,
      };
    }

    if (attempt === MAX_RETRIES - 1) {
      return {
        ok: false,
        details: `After ${MAX_RETRIES} retries, getByIds returned ${fetched.length}/${expectedIds.length} vectors`,
      };
    }
  }

  return { ok: false, details: "unreachable" };
}

// Cleanup helper — run after smoke test
export async function smokeCleanup(index: VectorizeIndex): Promise<void> {
  const ids = Array.from({ length: CHUNKS }, (_, i) => vectorIdFor(TRANSCRIPT_ID, i));
  await index.deleteByIds(ids);
}
