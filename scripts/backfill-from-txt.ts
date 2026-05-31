/**
 * Backfill past meetings into aftercall from a folder of .txt transcripts.
 *
 * Reads every *.txt under $FOLDER (default: ~/Documents/meeting transcripts),
 * parses the Bluedot-ish plaintext format produced by Bluedot's "Copy
 * transcript" / export flow, synthesizes Bluedot webhook payloads per file,
 * Svix-signs with $SIGNING_SECRET, POSTs to $WORKER_URL.
 *
 * By default it sends only `meeting.transcript.created` for backward
 * compatibility. Set EVENTS=both to also generate a Bluedot-like summary via
 * OpenAI and send `meeting.summary.created`, which lets the normal Worker
 * pipeline populate summary/action_items/participants.
 *
 * Idempotent: videoId is derived from the filename, so D1's UNIQUE(video_id)
 * dedupes re-runs.
 *
 *   SIGNING_SECRET=whsec_... \
 *   WORKER_URL=https://aftercall.<subdomain>.workers.dev \
 *   FOLDER="$HOME/Documents/meeting transcripts" \
 *   npx tsx scripts/backfill-from-txt.ts
 *
 * Dry run (default — doesn't POST):
 *   npx tsx scripts/backfill-from-txt.ts
 *
 * Live send:
 *   DRY_RUN=0 ... npx tsx scripts/backfill-from-txt.ts
 *
 * Live enriched backfill for a targeted export batch:
 *   FILE_PREFIX=my-export-prefix_ \
 *   EVENTS=both \
 *   OPENAI_API_KEY=sk-... \
 *   DRY_RUN=0 ... npx tsx scripts/backfill-from-txt.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";

/**
 * Fall back to reading a key out of .dev.vars so the script can run without
 * env vars once setup has been completed. .dev.vars is gitignored, so the
 * secret stays local.
 */
function readDevVar(key: string): string | undefined {
  const path = join(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?$/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

const FOLDER = process.env.FOLDER ?? join(homedir(), "Documents", "meeting transcripts");
const WORKER_URL = process.env.WORKER_URL ?? "";
const SIGNING_SECRET =
  process.env.SIGNING_SECRET ??
  readDevVar("BLUEDOT_WEBHOOK_SECRET") ??
  "";
const DRY_RUN = process.env.DRY_RUN !== "0";
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 2000);
const FILE_PREFIX = process.env.FILE_PREFIX ?? "";
const EVENTS = (process.env.EVENTS ?? "transcript").toLowerCase();
const SEND_TRANSCRIPT = EVENTS === "transcript" || EVENTS === "both";
const SEND_SUMMARY = EVENTS === "summary" || EVENTS === "both";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? readDevVar("OPENAI_API_KEY") ?? "";
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL ?? "gpt-5.5";
const SUMMARY_CHUNK_CHARS = Number(process.env.SUMMARY_CHUNK_CHARS ?? 20_000);

interface Utterance {
  speaker: string;
  text: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.txt$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Parse "Date: 4:36 PM on Apr 16, 2026" → unix seconds. Returns null on failure. */
function parseDateLine(raw: string): number | null {
  const m = raw.match(/Date:\s*(.+?)\s*$/);
  if (!m) return null;
  const cleaned = m[1].replace(/\s+on\s+/, " ");
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Parse "Length: 1h24m37s" → seconds. Returns undefined on failure. */
function parseLengthLine(raw: string): number | undefined {
  const m = raw.match(/Length:\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return undefined;
  const [h, mm, s] = [m[1], m[2], m[3]].map((x) => Number(x ?? 0));
  const total = h * 3600 + mm * 60 + s;
  return total || undefined;
}

/**
 * Parse the transcript body into speaker utterances. The expected shape is
 * blocks separated by blank lines where each block is:
 *   <Speaker Name>  <mm:ss>
 *   <one or more lines of text>
 *
 * Non-matching blocks are silently dropped.
 */
function parseUtterances(body: string): Utterance[] {
  const blocks = body.split(/\n\s*\n+/);
  const utts: Utterance[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const header = lines[0];
    // Look for the trailing timestamp token to split speaker / timestamp.
    const tsMatch = header.match(/^(.+?)\s+(\d+:\d+(?::\d+)?)\s*$/);
    if (!tsMatch) continue;
    const speaker = tsMatch[1].trim();
    const text = lines.slice(1).join(" ").trim();
    if (!text) continue;
    utts.push({ speaker, text });
  }
  return utts;
}

interface ParsedTranscript {
  title: string;
  videoId: string;
  createdAt: number;
  duration?: number;
  utterances: Utterance[];
  sourcePath: string;
}

function transcriptText(utterances: Utterance[]): string {
  return utterances
    .map((u) => {
      const speaker = u.speaker.replace(/^Speaker:\s*/, "").trim();
      return speaker ? `${speaker}: ${u.text}` : u.text;
    })
    .join("\n");
}

function splitTranscriptForSummary(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

async function summarizeChunk(
  client: OpenAI,
  input: {
    title: string;
    meetingDate: string;
    partLabel: string;
    transcript: string;
  },
): Promise<string> {
  const response = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content:
          "You create concise Bluedot-style meeting notes from transcripts. Preserve concrete action items, owners, dates, decisions, risks, and named participants. Do not invent details.",
      },
      {
        role: "user",
        content: `Meeting title: ${input.title}
Meeting date: ${input.meetingDate}
Transcript section: ${input.partLabel}

Transcript:
"""
${input.transcript}
"""

Write markdown with these sections:
## Overview
## Action Items
## Decisions
## Topics
## Participants

Use bullets. For action items, include owner and due date only when stated or directly inferable from the transcript.`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI returned empty summary content");
  return content;
}

async function generateBackfillSummary(parsed: ParsedTranscript, client: OpenAI): Promise<string> {
  const meetingDate = new Date(parsed.createdAt * 1000).toISOString().slice(0, 10);
  const chunks = splitTranscriptForSummary(transcriptText(parsed.utterances), SUMMARY_CHUNK_CHARS);

  if (chunks.length === 1) {
    return summarizeChunk(client, {
      title: parsed.title,
      meetingDate,
      partLabel: "full transcript",
      transcript: chunks[0],
    });
  }

  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    partials.push(await summarizeChunk(client, {
      title: parsed.title,
      meetingDate,
      partLabel: `part ${i + 1} of ${chunks.length}`,
      transcript: chunks[i],
    }));
  }

  return summarizeChunk(client, {
    title: parsed.title,
    meetingDate,
    partLabel: "merged section summaries",
    transcript: partials.map((s, i) => `# Section ${i + 1}\n${s}`).join("\n\n"),
  });
}

async function parseFile(path: string): Promise<ParsedTranscript | null> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  if (lines.length < 4) return null;

  const title = lines[0].trim() || "Untitled meeting";
  const dateLine = lines.find((l) => /^Date:/i.test(l)) ?? "";
  const lengthLine = lines.find((l) => /^Length:/i.test(l)) ?? "";

  let createdAt = parseDateLine(dateLine);
  if (createdAt == null) {
    const s = await stat(path);
    createdAt = Math.floor(s.mtimeMs / 1000);
  }
  const duration = parseLengthLine(lengthLine);

  // Body = everything after the header block. Skip until we see the first
  // blank line — the header typically ends with "Length: ...\n\n".
  const firstBlankIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "");
  const body = lines.slice(firstBlankIdx >= 0 ? firstBlankIdx + 1 : 4).join("\n");
  const utterances = parseUtterances(body);
  if (utterances.length === 0) return null;

  const filename = path.split("/").pop() ?? "";
  const videoId = `backfill:${slugify(filename)}`;

  return { title, videoId, createdAt, duration, utterances, sourcePath: path };
}

/** Svix-compatible signature. See src/webhook-verify.ts in this repo. */
function sign(body: string, secret: string): { id: string; timestamp: string; signature: string } {
  const id = `msg_${randomBytes(13).toString("hex")}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedContent = `${id}.${timestamp}.${body}`;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const hmac = createHmac("sha256", key).update(signedContent).digest("base64");
  return { id, timestamp, signature: `v1,${hmac}` };
}

async function postSigned(payload: unknown): Promise<{ ok: boolean; status: number; body: string }> {
  const body = JSON.stringify(payload);
  const { id, timestamp, signature } = sign(body, SIGNING_SECRET);

  const resp = await fetch(`${WORKER_URL.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body,
  });
  const respBody = await resp.text();
  return { ok: resp.ok, status: resp.status, body: respBody };
}

async function sendTranscriptEvent(parsed: ParsedTranscript): Promise<{ ok: boolean; status: number; body: string }> {
  return postSigned({
    type: "meeting.transcript.created",
    meetingId: parsed.videoId,
    videoId: parsed.videoId,
    title: parsed.title,
    createdAt: parsed.createdAt,
    duration: parsed.duration,
    attendees: [],
    language: "en",
    transcript: parsed.utterances,
  });
}

async function sendSummaryEvent(
  parsed: ParsedTranscript,
  summaryText: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  return postSigned({
    type: "meeting.summary.created",
    meetingId: parsed.videoId,
    videoId: parsed.videoId,
    title: parsed.title,
    createdAt: parsed.createdAt,
    duration: parsed.duration,
    attendees: [],
    summary: summaryText,
    summaryV2: summaryText,
  });
}

async function main() {
  console.log(`Folder:         ${FOLDER}`);
  console.log(`Worker URL:     ${WORKER_URL || "(unset)"}`);
  console.log(`Signing secret: ${SIGNING_SECRET ? "****** (set)" : "(unset)"}`);
  console.log(`File prefix:    ${FILE_PREFIX || "(none)"}`);
  console.log(`Events:         ${EVENTS}`);
  console.log(`Summary model:  ${SEND_SUMMARY ? SUMMARY_MODEL : "(not used)"}`);
  console.log(`Mode:           ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("");

  if (!SEND_TRANSCRIPT && !SEND_SUMMARY) {
    console.error("EVENTS must be one of: transcript, summary, both.");
    process.exit(1);
  }

  if (!DRY_RUN && (!WORKER_URL || !SIGNING_SECRET)) {
    console.error("LIVE mode requires WORKER_URL and SIGNING_SECRET env vars.");
    process.exit(1);
  }
  if (!DRY_RUN && SEND_SUMMARY && !OPENAI_API_KEY) {
    console.error("EVENTS=summary/both requires OPENAI_API_KEY in LIVE mode.");
    process.exit(1);
  }

  const openai = SEND_SUMMARY && !DRY_RUN
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

  const entries = await readdir(FOLDER);
  const txts = entries
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .filter((f) => !FILE_PREFIX || f.startsWith(FILE_PREFIX))
    .sort();
  console.log(`Found ${txts.length} .txt files.\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of txts) {
    const path = join(FOLDER, name);
    const parsed = await parseFile(path);
    if (!parsed) {
      console.log(`  [skip] ${name} — could not parse`);
      skipped++;
      continue;
    }

    const date = new Date(parsed.createdAt * 1000).toISOString().slice(0, 10);
    const dur = parsed.duration ? `${Math.round(parsed.duration / 60)}m` : "?";
    console.log(
      `  [${date}] ${parsed.title}  (${parsed.utterances.length} utterances, ${dur})`,
    );
    console.log(`           videoId=${parsed.videoId}`);

    if (DRY_RUN) {
      if (SEND_SUMMARY) {
        const approxChunks = splitTranscriptForSummary(
          transcriptText(parsed.utterances),
          SUMMARY_CHUNK_CHARS,
        ).length;
        console.log(`           summary generation: ${approxChunks} OpenAI chunk(s)`);
      }
      ok++;
      continue;
    }

    try {
      if (SEND_TRANSCRIPT) {
        const r = await sendTranscriptEvent(parsed);
        if (r.ok) {
          console.log(`           transcript -> ${r.status} ${r.body.slice(0, 60)}`);
        } else {
          console.log(`           transcript -> ${r.status} ${r.body.slice(0, 200)}`);
          failed++;
          continue;
        }
      }

      if (SEND_SUMMARY) {
        if (!openai) throw new Error("OpenAI client missing");
        const summary = await generateBackfillSummary(parsed, openai);
        const r = await sendSummaryEvent(parsed, summary);
        if (r.ok) {
          console.log(`           summary    -> ${r.status} ${r.body.slice(0, 60)}`);
        } else {
          console.log(`           summary    -> ${r.status} ${r.body.slice(0, 200)}`);
          failed++;
          continue;
        }
      }

      ok++;
    } catch (err) {
      console.log(`           -> ERROR ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    if (THROTTLE_MS > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  console.log("");
  console.log(`Done: ${ok} ok, ${skipped} skipped, ${failed} failed.`);
  if (DRY_RUN) {
    console.log(`(Dry run — no HTTP requests made. Re-run with DRY_RUN=0 to send.)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
