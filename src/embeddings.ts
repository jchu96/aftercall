import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Chunking algorithm version. Bumped whenever `chunkTranscript` changes chunk
 * boundaries in a way that invalidates already-stored vectors.
 *   v1 = sentence-boundary, speaker-unaware (legacy — no version written)
 *   v2 = turn-aware (speaker-labeled) chunks
 * `scripts/reindex-transcripts.ts` re-embeds any row below this version.
 */
export const CHUNK_SCHEMA_VERSION = 2;

const CHARS_PER_TOKEN = 4;

export interface Chunk {
  index: number;
  text: string;
}

export interface EmbeddedChunk extends Chunk {
  chunkIndex: number;
  embedding: number[];
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens?: number;
}

interface Turn {
  speaker: string;
  text: string;
}

/**
 * Parse a single line as a `Speaker: utterance` header, or return null when it
 * isn't one (so it can be attached as a continuation of the prior speaker).
 *
 * Guards against treating a mid-utterance colon (`So here's the deal: ...`) as
 * a speaker: the pre-colon span must look like a name — ≤5 words, each word
 * starting with an uppercase letter or digit. A caller-supplied roster of known
 * speakers takes precedence over the heuristic.
 */
function parseSpeakerLine(line: string, known?: Set<string>): Turn | null {
  const m = line.match(/^\s*([^:\n]{1,60}):\s+(\S.*)$/);
  if (!m) return null;
  const speaker = m[1].trim();
  const text = m[2].trim();
  if (!speaker || !text) return null;

  if (known && known.has(speaker.toLowerCase())) return { speaker, text };

  const words = speaker.split(/\s+/);
  if (words.length > 5) return null;
  for (const w of words) {
    // Each word must start with an uppercase letter, an uncased-script letter
    // (CJK/Thai/Hebrew/etc. — \p{Lo}), or a digit. Lowercase Latin (\p{Ll})
    // stays rejected so mid-utterance prose ("here's the deal:") isn't a header.
    if (!/^[\p{Lu}\p{Lo}\p{N}]/u.test(w)) return null;
  }
  return { speaker, text };
}

/**
 * Parse transcript lines into speaker turns, merging consecutive same-speaker
 * lines (including Bluedot's single-word fragments) into one turn block.
 * Returns null when no speaker labels are present at all (plain text).
 */
function parseTurns(text: string, known?: Set<string>): Turn[] | null {
  const lines = text.split("\n");
  const turns: Turn[] = [];
  let sawHeader = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseSpeakerLine(line, known);
    if (parsed) {
      sawHeader = true;
      const last = turns[turns.length - 1];
      if (last && last.speaker === parsed.speaker) {
        last.text += ` ${parsed.text}`;
      } else {
        turns.push(parsed);
      }
    } else if (turns.length > 0) {
      // Continuation of the current speaker's turn (wrapped line).
      turns[turns.length - 1].text += ` ${line.trim()}`;
    } else {
      // Leading unlabeled text before any speaker — attach to a synthetic turn.
      turns.push({ speaker: "Unknown", text: line.trim() });
    }
  }

  return sawHeader ? turns : null;
}

function renderTurn(t: Turn): string {
  return `${t.speaker}: ${t.text}`;
}

/**
 * Split one oversized utterance (a single turn longer than maxChars) into
 * labeled pieces, re-prepending the speaker on every piece and marking the
 * 2nd+ as `(continued)` so attribution survives the split.
 */
function splitOversizedTurn(t: Turn, maxChars: number): string[] {
  const contLabel = `${t.speaker} (continued): `;
  const budget = Math.max(20, maxChars - contLabel.length);
  const pieces = splitPlainText(t.text, budget, 0);
  return pieces.map((p, i) =>
    i === 0 ? `${t.speaker}: ${p}` : `${t.speaker} (continued): ${p}`,
  );
}

/**
 * Speaker-aware transcript chunking.
 *
 * Transcripts are `Speaker Name: utterance` per line. We pack whole turns up to
 * the token budget and NEVER split a turn across a chunk boundary, so every
 * emitted chunk begins with a speaker label and `answer_from_transcript` can
 * attribute statements correctly. Plain (non-transcript) text falls back to the
 * legacy sentence-boundary chunker.
 *
 * Token count is approximated via character length (~4 chars/token for English).
 */
export function chunkTranscript(
  text: string,
  options: ChunkOptions & { speakers?: string[] },
): Chunk[] {
  if (!text || !text.trim()) {
    throw new Error("chunkTranscript: input is empty");
  }

  // Normalize line endings so CRLF (\r\n) / lone-CR transcripts parse the same
  // as LF — a trailing \r otherwise defeats the speaker-line regex and collapses
  // the whole call into one mis-attributed turn.
  text = text.replace(/\r\n?/g, "\n");

  const maxChars = options.maxTokens * CHARS_PER_TOKEN;
  const overlapChars = (options.overlapTokens ?? 0) * CHARS_PER_TOKEN;

  const known = options.speakers && options.speakers.length > 0
    ? new Set(options.speakers.map((s) => s.toLowerCase()))
    : undefined;
  const turns = parseTurns(text, known);

  // No speaker labels → plain text. Preserve the legacy sentence-based chunker.
  if (!turns) {
    return splitPlainText(text, maxChars, overlapChars).map((t, index) => ({ index, text: t }));
  }

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (current.length) {
      chunks.push({ index: chunkIndex++, text: current.join("\n") });
    }
  };

  for (const turn of turns) {
    const rendered = renderTurn(turn);

    if (rendered.length > maxChars) {
      // Oversized turn — flush what we have, emit labeled sub-chunks.
      flush();
      current = [];
      currentLen = 0;
      for (const piece of splitOversizedTurn(turn, maxChars)) {
        chunks.push({ index: chunkIndex++, text: piece });
      }
      continue;
    }

    if (current.length > 0 && currentLen + rendered.length + 1 > maxChars) {
      const prevLast = current[current.length - 1];
      flush();
      // Seed the next chunk with the boundary turn for overlap — but only when
      // it still leaves room for `rendered`, else the chunk would exceed budget.
      if (overlapChars > 0 && prevLast.length + rendered.length + 2 <= maxChars) {
        current = [prevLast];
        currentLen = prevLast.length + 1;
      } else {
        current = [];
        currentLen = 0;
      }
    }

    current.push(rendered);
    currentLen += rendered.length + 1;
  }
  flush();

  return chunks;
}

/**
 * Legacy sentence-boundary splitter — used for plain (non-speaker) text and as
 * the inner splitter for oversized single turns. Returns trimmed string pieces.
 */
function splitPlainText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) {
    return [text.trim()];
  }

  const pieces: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const end = Math.min(cursor + maxChars, text.length);
    let sliceEnd = end;

    if (end < text.length) {
      const window = text.slice(cursor, end);
      const sentenceMatch = window.match(/[.!?]\s[^.!?]*$/);
      if (sentenceMatch && sentenceMatch.index !== undefined) {
        sliceEnd = cursor + sentenceMatch.index + 1;
      } else {
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace > maxChars * 0.5) {
          sliceEnd = cursor + lastSpace;
        }
      }
    }

    const piece = text.slice(cursor, sliceEnd).trim();
    if (piece) pieces.push(piece);

    if (sliceEnd >= text.length) break;

    cursor = overlapChars > 0 ? Math.max(cursor + 1, sliceEnd - overlapChars) : sliceEnd;
  }

  return pieces;
}

export interface EmbeddingOptions {
  client: OpenAI;
  model?: string;
  retries?: number;
  retryDelayMs?: number;
}

export async function generateEmbeddings(
  chunks: Chunk[],
  options: EmbeddingOptions,
): Promise<EmbeddedChunk[]> {
  const model = options.model ?? EMBEDDING_MODEL;
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await options.client.embeddings.create({
        model,
        input: chunks.map((c) => c.text),
      });

      return response.data.map((item, i) => {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding dimension mismatch: got ${item.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
        return {
          index: chunks[i].index,
          chunkIndex: chunks[i].index,
          text: chunks[i].text,
          embedding: item.embedding,
        };
      });
    } catch (err) {
      lastErr = err;
      if ((err as Error).message?.toLowerCase().includes("dimension")) throw err;
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === retries - 1) throw err;
      const delay = retryDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}
