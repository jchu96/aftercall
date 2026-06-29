import OpenAI from "openai";
import type { Env } from "../../env";
import { chunkTranscript } from "../../embeddings";
import { embedQuery } from "../../embed";
import { DEFAULT_MODEL } from "../../extract";
import type { ToolResult } from "./recent_calls";
import { resolveTranscript, formatCandidates } from "../resolve";

export interface AnswerFromTranscriptInput {
  video_id: string;
  question: string;
}

export interface AnswerFromTranscriptDeps {
  openai?: OpenAI;
  vectorize?: VectorizeIndex;
  retries?: number;
  retryDelayMs?: number;
}

interface TranscriptRow {
  id: number;
  raw_text: string | null;
  title: string;
}

const TOP_K = 8;
const RAW_TEXT_FALLBACK_MAX = 24_000;

const SYSTEM_PROMPT = `You answer questions about a single meeting using only the provided transcript excerpts.

Each excerpt is verbatim transcript in \`Speaker Name: utterance\` line format; one excerpt may contain several speakers and turns. Attribute every statement to the exact speaker whose label precedes it — never merge or swap speakers. A line marked \`(continued)\` is the same speaker continuing. If asked who said something and the label is absent or ambiguous, say so rather than guessing.

Quote or paraphrase specifics from the excerpts when relevant. If the excerpts don't contain the answer, say so plainly — do not invent details.`;

/**
 * Cold-Vectorize fallback: instead of blindly truncating raw_text to its first
 * N chars (which drops late content), turn-chunk it and pick the chunks whose
 * words overlap the question, preserving original order. No embeddings — this
 * is the fallback for exactly when the vector index hasn't caught up.
 */
function selectFallbackExcerpts(rawText: string, question: string, budget: number): string[] {
  const chunks = chunkTranscript(rawText, { maxTokens: 500 });
  const qWords = new Set(
    (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2),
  );
  const scored = chunks.map((c, i) => {
    const words = c.text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    let score = 0;
    for (const w of words) if (qWords.has(w)) score++;
    return { i, text: c.text, score };
  });
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: typeof ranked = [];
  let used = 0;
  for (const s of ranked) {
    if (picked.length > 0 && used + s.text.length > budget) break;
    picked.push(s);
    used += s.text.length;
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map((p) => p.text);
}

function buildUserMessage(title: string, excerpts: string[], question: string): string {
  const joined = excerpts.map((e, i) => `[excerpt ${i + 1}]\n${e}`).join("\n\n---\n\n");
  return `Meeting: ${title}

Transcript excerpts:
${joined}

Question: ${question}`;
}

export async function answerFromTranscript(
  input: AnswerFromTranscriptInput,
  env: Env,
  deps: AnswerFromTranscriptDeps = {},
): Promise<ToolResult> {
  const openai = deps.openai ?? new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const vectorize = deps.vectorize ?? env.VECTORIZE;
  const retries = deps.retries ?? 3;
  const retryDelayMs = deps.retryDelayMs ?? 500;

  // Exact → normalized → fuzzy resolution so a pasted URL / code / title works.
  const resolved = await resolveTranscript(input.video_id, env);
  if (resolved.kind === "miss") {
    return {
      content: [{ type: "text", text: `Call not found: \`${input.video_id}\`` }],
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      content: [
        {
          type: "text",
          text: `Multiple calls match "${input.video_id}" — re-run answer_from_transcript with one exact \`video_id\`:\n\n${formatCandidates(
            resolved.rows,
          )}`,
        },
      ],
    };
  }

  const row = await env.DB
    .prepare("SELECT id, raw_text, title FROM transcripts WHERE id = ?1")
    .bind(resolved.row.id)
    .first<TranscriptRow>();

  if (!row) {
    return {
      content: [
        { type: "text", text: `Call not found: \`${input.video_id}\`` },
      ],
    };
  }

  const queryVector = await embedQuery(openai, input.question);

  const queryResult = await vectorize.query(queryVector, {
    topK: TOP_K,
    returnMetadata: "all",
    filter: { transcript_id: row.id },
  });

  let excerpts: string[] = (queryResult.matches ?? [])
    .map((m) => String((m.metadata as { chunk_text?: unknown })?.chunk_text ?? ""))
    .filter((t) => t.length > 0);

  if (excerpts.length === 0) {
    // Vectorize is eventually consistent; fall back to the raw transcript in D1
    // when the index hasn't caught up. Pick question-relevant, speaker-labeled
    // turns rather than blindly truncating the first N chars.
    if (row.raw_text && row.raw_text.trim().length > 0) {
      excerpts = selectFallbackExcerpts(row.raw_text, input.question, RAW_TEXT_FALLBACK_MAX);
    } else {
      return {
        content: [
          {
            type: "text",
            text: "Transcript not yet indexed — try again in a moment.",
          },
        ],
      };
    }
  }

  const userMessage = buildUserMessage(row.title, excerpts, input.question);

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: env.OPENAI_EXTRACTION_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      });
      const answer = resp.choices[0]?.message?.content ?? "";
      return {
        content: [{ type: "text", text: answer }],
      };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}
