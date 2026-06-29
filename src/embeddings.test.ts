import { describe, it, expect, vi } from "vitest";
import { chunkTranscript, generateEmbeddings } from "./embeddings";

describe("chunkTranscript", () => {
  it("returns a single chunk for short input", () => {
    const chunks = chunkTranscript("Short transcript.", { maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short transcript.");
    expect(chunks[0].index).toBe(0);
  });

  it("splits long input into multiple overlapping chunks", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const chunks = chunkTranscript(text, { maxTokens: 200, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks.at(-1)!.index).toBe(chunks.length - 1);

    // Overlap: at least a few words of chunk 0's tail should appear somewhere
    // early in chunk 1 (sentence-boundary alignment may shift the exact start).
    const firstTail = chunks[0].text.split(/\s+/).slice(-5).join(" ");
    expect(chunks[1].text.slice(0, firstTail.length + 50)).toContain(firstTail);
  });

  it("preserves sentence boundaries where possible", () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `This is sentence ${i}.`).join(" ");
    const chunks = chunkTranscript(sentences, { maxTokens: 100, overlapTokens: 10 });
    for (const chunk of chunks) {
      // Chunks should end with a period (preferring sentence boundary).
      expect(chunk.text.trim().endsWith(".")).toBe(true);
    }
  });

  it("rejects empty input", () => {
    expect(() => chunkTranscript("", { maxTokens: 100 })).toThrow(/empty/i);
    expect(() => chunkTranscript("   ", { maxTokens: 100 })).toThrow(/empty/i);
  });
});

const SPEAKER_LINE = /^[^:\n]+: /;

describe("chunkTranscript — turn-aware (speaker-labeled transcripts)", () => {
  it("packs several short turns under the limit into one chunk carrying every label", () => {
    const text = [
      "Andy Pilipović: Oh, you good?",
      "Jeremy Chu: I'm so tired.",
      "Andy Pilipović: I just got my apartment yesterday.",
    ].join("\n");
    const chunks = chunkTranscript(text, { maxTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Andy Pilipović:");
    expect(chunks[0].text).toContain("Jeremy Chu:");
  });

  it("every emitted chunk begins with a Speaker: label (never starts mid-utterance)", () => {
    const turns: string[] = [];
    for (let i = 0; i < 60; i++) {
      const who = i % 2 === 0 ? "Jeremy Chu" : "Andy Pilipović";
      turns.push(`${who}: This is utterance number ${i} with enough words to add length.`);
    }
    const chunks = chunkTranscript(turns.join("\n"), { maxTokens: 80, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text).toMatch(SPEAKER_LINE);
    }
  });

  it("never splits a turn across chunks (each chunk boundary falls between turns)", () => {
    const turns: string[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push(`Speaker ${i % 3}: Sentence one here. Sentence two here. Sentence three here.`);
    }
    const chunks = chunkTranscript(turns.join("\n"), { maxTokens: 90, overlapTokens: 0 });
    for (const c of chunks) {
      // No internal line should be an unlabeled orphan: every non-empty line is a turn.
      for (const line of c.text.split("\n")) {
        if (line.trim()) expect(line).toMatch(SPEAKER_LINE);
      }
    }
  });

  it("attributes a continuation line (no Name: prefix) to the prior speaker", () => {
    const text = [
      "Jeremy Chu: I wanted to run something by you and it is a fairly long",
      "thought that wrapped onto a second line without a label.",
      "Andy Pilipović: Sure, go ahead.",
    ].join("\n");
    const chunks = chunkTranscript(text, { maxTokens: 500 });
    expect(chunks[0].text).toContain("wrapped onto a second line");
    // The continuation text stays under Jeremy's turn, not orphaned.
    const jeremyIdx = chunks[0].text.indexOf("Jeremy Chu:");
    const andyIdx = chunks[0].text.indexOf("Andy Pilipović:");
    const contIdx = chunks[0].text.indexOf("wrapped onto a second line");
    expect(contIdx).toBeGreaterThan(jeremyIdx);
    expect(contIdx).toBeLessThan(andyIdx);
  });

  it("merges consecutive same-speaker fragment lines into one labeled turn", () => {
    const text = ["Jeremy Chu: I.", "Jeremy Chu: That's.", "Jeremy Chu: Anyway."].join("\n");
    const chunks = chunkTranscript(text, { maxTokens: 500 });
    // One merged turn → the label appears exactly once.
    const labelCount = (chunks[0].text.match(/Jeremy Chu:/g) ?? []).length;
    expect(labelCount).toBe(1);
    expect(chunks[0].text).toContain("I.");
    expect(chunks[0].text).toContain("That's.");
    expect(chunks[0].text).toContain("Anyway.");
  });

  it("starts a new turn on speaker change (does not merge different speakers)", () => {
    const text = ["Jeremy Chu: Hi.", "Andy Pilipović: Hey.", "Jeremy Chu: Bye."].join("\n");
    const chunks = chunkTranscript(text, { maxTokens: 500 });
    expect((chunks[0].text.match(/Jeremy Chu:/g) ?? []).length).toBe(2);
    expect((chunks[0].text.match(/Andy Pilipović:/g) ?? []).length).toBe(1);
  });

  it("splits an oversized single turn but re-prepends the speaker label to each piece", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i} is here.`).join(" ");
    const text = `Jeremy Chu: ${long}`;
    const chunks = chunkTranscript(text, { maxTokens: 40, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text).toMatch(/^Jeremy Chu( \(continued\))?: /);
    }
    // Continuation marker on 2nd+ pieces.
    expect(chunks.at(-1)!.text).toContain("(continued)");
  });

  it("does not treat a mid-utterance colon as a new speaker", () => {
    const text = [
      "Jeremy Chu: So here's the deal: we ship Friday.",
      "Andy Pilipović: Works for me.",
    ].join("\n");
    const chunks = chunkTranscript(text, { maxTokens: 500 });
    // Only two real turns — "here's the deal" must not become a speaker.
    expect((chunks[0].text.match(SPEAKER_LINE.source ? /^[^:\n]+: /gm : / /g) ?? []).length).toBe(2);
    expect(chunks[0].text).not.toMatch(/here's the deal:\s*$/m);
  });

  it("applies 1-turn overlap when overlapTokens > 0 (boundary turn repeated, still labeled)", () => {
    const turns: string[] = [];
    for (let i = 0; i < 30; i++) {
      turns.push(`Speaker ${i % 2}: Utterance ${i} padded out with several extra words here.`);
    }
    const chunks = chunkTranscript(turns.join("\n"), { maxTokens: 80, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // The last turn of chunk i should reappear as the first turn of chunk i+1.
    const firstChunkLastLine = chunks[0].text.trim().split("\n").at(-1)!;
    expect(chunks[1].text).toContain(firstChunkLastLine.trim());
    expect(chunks[1].text).toMatch(SPEAKER_LINE);
  });
});

describe("generateEmbeddings", () => {
  it("calls OpenAI embeddings API and returns vectors", async () => {
    const mockEmbedding = new Array(1536).fill(0).map((_, i) => i / 1536);
    const mockCreate = vi.fn().mockResolvedValue({
      data: [
        { embedding: mockEmbedding, index: 0 },
        { embedding: mockEmbedding, index: 1 },
      ],
      model: "text-embedding-3-small",
      usage: { total_tokens: 50 },
    });
    const fakeClient = { embeddings: { create: mockCreate } };

    const result = await generateEmbeddings(
      [
        { index: 0, text: "first chunk" },
        { index: 1, text: "second chunk" },
      ],
      { client: fakeClient as never },
    );

    expect(result).toHaveLength(2);
    expect(result[0].embedding).toHaveLength(1536);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[1].chunkIndex).toBe(1);
    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["first chunk", "second chunk"],
    });
  });

  it("retries on transient server errors", async () => {
    const err = Object.assign(new Error("server"), { status: 502 });
    const mockCreate = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
        model: "text-embedding-3-small",
        usage: { total_tokens: 10 },
      });

    const result = await generateEmbeddings(
      [{ index: 0, text: "one" }],
      { client: { embeddings: { create: mockCreate } } as never, retryDelayMs: 1 },
    );

    expect(result).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const err = Object.assign(new Error("bad"), { status: 400 });
    const mockCreate = vi.fn().mockRejectedValue(err);

    await expect(
      generateEmbeddings([{ index: 0, text: "x" }], {
        client: { embeddings: { create: mockCreate } } as never,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(/bad/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("throws if embedding dimensions mismatch expected", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: new Array(768).fill(0), index: 0 }],
      model: "wrong",
      usage: { total_tokens: 5 },
    });

    await expect(
      generateEmbeddings(
        [{ index: 0, text: "x" }],
        { client: { embeddings: { create: mockCreate } } as never, retryDelayMs: 1 },
      ),
    ).rejects.toThrow(/dimension/i);
  });
});
