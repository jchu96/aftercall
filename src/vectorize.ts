export const VECTOR_DIMENSIONS = 1536;
const BATCH_SIZE = 100;
const METADATA_TEXT_MAX = 2048;

export interface EmbeddedChunk {
  transcriptId: number;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface VectorMetadata {
  transcript_id: number;
  chunk_index: number;
  chunk_text: string;
}

export function vectorIdFor(transcriptId: number, chunkIndex: number): string {
  return `${transcriptId}-${chunkIndex}`;
}

/**
 * Upsert chunk embeddings into a Cloudflare Vectorize index.
 *
 * - IDs are deterministic (`{transcript_id}-{chunk_index}`) so retries from
 *   Bluedot don't create duplicates.
 * - Batched in groups of 100 (Vectorize's recommended max per call).
 * - Metadata `chunk_text` truncated to 2KB to stay under Vectorize's 10KB
 *   metadata limit per vector.
 * - Note: Vectorize is async-eventual — a query immediately after upsert
 *   may not see the just-inserted vector. Smoke tests should retry.
 */
export async function upsertChunkEmbeddings(
  index: VectorizeIndex,
  chunks: EmbeddedChunk[],
): Promise<void> {
  if (chunks.length === 0) return;

  for (const c of chunks) {
    if (c.embedding.length !== VECTOR_DIMENSIONS) {
      throw new Error(
        `Vector dimension mismatch: got ${c.embedding.length}, expected ${VECTOR_DIMENSIONS} (transcript ${c.transcriptId} chunk ${c.chunkIndex})`,
      );
    }
  }

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = batch.map((c) => ({
      id: vectorIdFor(c.transcriptId, c.chunkIndex),
      values: c.embedding,
      metadata: {
        transcript_id: c.transcriptId,
        chunk_index: c.chunkIndex,
        chunk_text: c.text.slice(0, METADATA_TEXT_MAX),
      } satisfies VectorMetadata,
    }));
    await index.upsert(vectors);
  }
}
