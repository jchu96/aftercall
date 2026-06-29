/**
 * Embedding provider seam.
 *
 * This is the ONE place query-time embeddings are produced. The batch path used
 * at ingest lives in `embeddings.generateEmbeddings`. To switch providers
 * (e.g. Google `gemini-embedding-001`), reimplement BOTH:
 *   - `embedQuery` here (query-time, single text), and
 *   - `generateEmbeddings` in `./embeddings` (ingest-time, batched),
 * then re-run `scripts/reindex-transcripts.ts` so stored vectors match.
 *
 * Keep the output at 1536 dimensions so the existing Vectorize index
 * (`aftercall-vectors`, 1536d cosine) needs no recreation — Gemini supports a
 * 1536-dim Matryoshka truncation that lands here drop-in.
 *
 * NOTE: stored vectors and query vectors MUST come from the same model — never
 * mix providers within one index.
 */
import type OpenAI from "openai";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embeddings";

/** Embed a single query string into a 1536-dim vector. */
export async function embedQuery(client: OpenAI, text: string): Promise<number[]> {
  const resp = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return resp.data[0].embedding;
}
