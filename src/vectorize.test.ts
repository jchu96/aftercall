import { describe, it, expect, vi } from "vitest";
import { upsertChunkEmbeddings, vectorIdFor, type EmbeddedChunk } from "./vectorize";

function makeEmbedded(transcriptId: number, count: number): EmbeddedChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    transcriptId,
    chunkIndex: i,
    text: `chunk ${i}`,
    embedding: new Array(1536).fill(0).map((_, j) => (i + j) / 1536),
  }));
}

function fakeIndex() {
  return {
    upsert: vi.fn().mockResolvedValue({ mutationId: "m1" }),
    query: vi.fn(),
    deleteByIds: vi.fn(),
  } as unknown as VectorizeIndex;
}

describe("vectorIdFor", () => {
  it("produces deterministic ids", () => {
    expect(vectorIdFor(42, 0)).toBe("42-0");
    expect(vectorIdFor(42, 7)).toBe("42-7");
  });
});

describe("upsertChunkEmbeddings", () => {
  it("upserts a small batch in a single call", async () => {
    const idx = fakeIndex();
    const chunks = makeEmbedded(7, 3);

    await upsertChunkEmbeddings(idx, chunks);

    expect(idx.upsert).toHaveBeenCalledOnce();
    const arg = (idx.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toHaveLength(3);
    expect(arg[0]).toMatchObject({
      id: "7-0",
      values: chunks[0].embedding,
      metadata: { transcript_id: 7, chunk_index: 0, chunk_text: "chunk 0" },
    });
  });

  it("batches large upserts into groups of 100", async () => {
    const idx = fakeIndex();
    const chunks = makeEmbedded(1, 250);

    await upsertChunkEmbeddings(idx, chunks);

    expect(idx.upsert).toHaveBeenCalledTimes(3);
    const calls = (idx.upsert as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toHaveLength(100);
    expect(calls[1][0]).toHaveLength(100);
    expect(calls[2][0]).toHaveLength(50);
  });

  it("truncates chunk_text in metadata to 2KB to stay under Vectorize limits", async () => {
    const idx = fakeIndex();
    const longText = "x".repeat(5000);
    const chunks: EmbeddedChunk[] = [
      {
        transcriptId: 1,
        chunkIndex: 0,
        text: longText,
        embedding: new Array(1536).fill(0.1),
      },
    ];

    await upsertChunkEmbeddings(idx, chunks);

    const arg = (idx.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg[0].metadata.chunk_text.length).toBeLessThanOrEqual(2048);
  });

  it("no-ops on empty input", async () => {
    const idx = fakeIndex();
    await upsertChunkEmbeddings(idx, []);
    expect(idx.upsert).not.toHaveBeenCalled();
  });

  it("rejects vectors with wrong dimensions", async () => {
    const idx = fakeIndex();
    const bad: EmbeddedChunk[] = [
      {
        transcriptId: 1,
        chunkIndex: 0,
        text: "x",
        embedding: new Array(768).fill(0),
      },
    ];

    await expect(upsertChunkEmbeddings(idx, bad)).rejects.toThrow(/dimension/i);
  });
});
