import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { setupD1 } from "../../../test/setup-d1";
import { answerFromTranscript } from "./answer_from_transcript";

describe("answerFromTranscript", () => {
  beforeEach(async () => {
    await setupD1();
  });

  async function seedTranscript(opts: {
    id: number;
    videoId: string;
    title?: string;
    rawText?: string;
  }): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO transcripts (id, video_id, title, raw_text, summary)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(opts.id, opts.videoId, opts.title ?? "x", opts.rawText ?? "raw", "summary")
      .run();
  }

  function fakeOpenAI(answer: string) {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: answer } }],
    });
    const embeddings = vi.fn().mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    });
    return {
      client: {
        chat: { completions: { create } },
        embeddings: { create: embeddings },
      } as never,
      create,
      embeddings,
    };
  }

  function fakeVectorize(matches: Array<{ score: number; chunk_text: string; transcript_id: number }>) {
    const query = vi.fn().mockResolvedValue({
      matches: matches.map((m, i) => ({
        id: `${m.transcript_id}-${i}`,
        score: m.score,
        metadata: { transcript_id: m.transcript_id, chunk_index: i, chunk_text: m.chunk_text },
      })),
    });
    return { query } as unknown as VectorizeIndex;
  }

  it("resolves video_id to transcript_id via D1 lookup", async () => {
    await seedTranscript({ id: 42, videoId: "vid_42", rawText: "irrelevant" });
    const { client } = fakeOpenAI("the answer");
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "relevant excerpt", transcript_id: 42 },
    ]);

    await answerFromTranscript(
      { video_id: "vid_42", question: "what?" },
      env,
      { openai: client, vectorize },
    );

    const [, opts] = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.filter).toEqual({ transcript_id: 42 });
  });

  it("returns helpful error for unknown video_id", async () => {
    const { client } = fakeOpenAI("n/a");
    const vectorize = fakeVectorize([]);

    const out = await answerFromTranscript(
      { video_id: "nonexistent", question: "what?" },
      env,
      { openai: client, vectorize },
    );

    expect(out.content[0].text.toLowerCase()).toContain("not found");
    expect(out.content[0].text).toContain("nonexistent");
    expect(vectorize.query).not.toHaveBeenCalled();
  });

  it("filters vectorize by transcript_id metadata and passes topK=8", async () => {
    await seedTranscript({ id: 7, videoId: "vid_7" });
    const { client } = fakeOpenAI("answer");
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "chunk", transcript_id: 7 },
    ]);

    await answerFromTranscript(
      { video_id: "vid_7", question: "q" },
      env,
      { openai: client, vectorize },
    );

    const [, opts] = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.filter).toEqual({ transcript_id: 7 });
    expect(opts.topK).toBe(8);
  });

  it("falls back to d1 raw_text when vectorize returns no chunks", async () => {
    await seedTranscript({
      id: 99,
      videoId: "vid_99",
      rawText: "This is the raw transcript used as fallback.",
    });
    const { client, create } = fakeOpenAI("fallback-based answer");
    const vectorize = fakeVectorize([]); // zero matches — eventual consistency case

    const out = await answerFromTranscript(
      { video_id: "vid_99", question: "q" },
      env,
      { openai: client, vectorize },
    );

    expect(create).toHaveBeenCalledOnce();
    const userMsg = (create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("This is the raw transcript used as fallback.");
    expect(out.content[0].text).toBe("fallback-based answer");
  });

  it("fallback selects the question-relevant turn, not just the head of raw_text", async () => {
    const head = Array.from({ length: 30 }, (_, i) => `Alice: filler line ${i} about logistics.`).join("\n");
    const relevant = "Bob: The pricing decision was to raise enterprise tiers by twenty percent.";
    await seedTranscript({
      id: 77,
      videoId: "vid_77",
      rawText: `${head}\n${relevant}`,
    });
    const { client, create } = fakeOpenAI("answer about pricing");
    const vectorize = fakeVectorize([]); // force raw_text fallback

    await answerFromTranscript(
      { video_id: "vid_77", question: "what was the pricing decision?" },
      env,
      { openai: client, vectorize },
    );

    const userMsg = (create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("raise enterprise tiers by twenty percent");
  });

  it("resolves a schemeless-stored row when given a full Meet URL", async () => {
    await env.DB.prepare(
      `INSERT INTO transcripts (id, video_id, title, raw_text, summary, meeting_code)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(50, "meet.google.com/www-jjni-xtd", "x", "Bob: hi", "s", "www-jjni-xtd")
      .run();
    const { client } = fakeOpenAI("ok");
    const vectorize = fakeVectorize([{ score: 0.9, chunk_text: "Bob: hi", transcript_id: 50 }]);

    await answerFromTranscript(
      { video_id: "https://meet.google.com/www-jjni-xtd", question: "q" },
      env,
      { openai: client, vectorize },
    );

    const [, opts] = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.filter).toEqual({ transcript_id: 50 });
  });

  it("includes the Speaker: format instruction in the system prompt", async () => {
    await seedTranscript({ id: 8, videoId: "vid_8" });
    const { client, create } = fakeOpenAI("a");
    const vectorize = fakeVectorize([{ score: 0.9, chunk_text: "Bob: hi", transcript_id: 8 }]);

    await answerFromTranscript({ video_id: "vid_8", question: "q" }, env, {
      openai: client,
      vectorize,
    });

    const sysMsg = (create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === "system")!.content;
    expect(sysMsg).toMatch(/speaker/i);
  });

  it("returns a not-yet-indexed message when vectorize returns nothing AND raw_text is empty", async () => {
    await seedTranscript({ id: 11, videoId: "vid_11", rawText: "" });
    const { client, create } = fakeOpenAI("should not be called");
    const vectorize = fakeVectorize([]);

    const out = await answerFromTranscript(
      { video_id: "vid_11", question: "q" },
      env,
      { openai: client, vectorize },
    );

    expect(create).not.toHaveBeenCalled();
    expect(out.content[0].text.toLowerCase()).toContain("not yet indexed");
  });

  it("passes top-K chunks as context to openai concatenated with separators", async () => {
    await seedTranscript({ id: 5, videoId: "vid_5" });
    const { client, create } = fakeOpenAI("synthesized answer");
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "first chunk text", transcript_id: 5 },
      { score: 0.85, chunk_text: "second chunk text", transcript_id: 5 },
      { score: 0.8, chunk_text: "third chunk text", transcript_id: 5 },
    ]);

    await answerFromTranscript(
      { video_id: "vid_5", question: "q" },
      env,
      { openai: client, vectorize },
    );

    const userMsg = (create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("first chunk text");
    expect(userMsg).toContain("second chunk text");
    expect(userMsg).toContain("third chunk text");
  });

  it("retries on transient OpenAI errors (5xx)", async () => {
    await seedTranscript({ id: 1, videoId: "vid_1" });
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "chunk", transcript_id: 1 },
    ]);
    const transientErr = Object.assign(new Error("server boom"), { status: 503 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValue({ choices: [{ message: { content: "eventual answer" } }] });
    const embeddings = vi.fn().mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    });
    const client = {
      chat: { completions: { create } },
      embeddings: { create: embeddings },
    } as never;

    const out = await answerFromTranscript(
      { video_id: "vid_1", question: "q" },
      env,
      { openai: client, vectorize, retryDelayMs: 1 },
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(out.content[0].text).toBe("eventual answer");
  });

  it("does NOT retry on client errors (4xx that aren't 429)", async () => {
    await seedTranscript({ id: 1, videoId: "vid_1" });
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "chunk", transcript_id: 1 },
    ]);
    const clientErr = Object.assign(new Error("bad request"), { status: 400 });
    const create = vi.fn().mockRejectedValue(clientErr);
    const embeddings = vi.fn().mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    });
    const client = {
      chat: { completions: { create } },
      embeddings: { create: embeddings },
    } as never;

    await expect(
      answerFromTranscript(
        { video_id: "vid_1", question: "q" },
        env,
        { openai: client, vectorize, retryDelayMs: 1 },
      ),
    ).rejects.toThrow(/bad request/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns { content: [{ type: 'text', text: <answer> }] } on success", async () => {
    await seedTranscript({ id: 3, videoId: "vid_3" });
    const { client } = fakeOpenAI("final answer text");
    const vectorize = fakeVectorize([
      { score: 0.9, chunk_text: "chunk", transcript_id: 3 },
    ]);

    const out = await answerFromTranscript(
      { video_id: "vid_3", question: "q" },
      env,
      { openai: client, vectorize },
    );

    expect(out).toEqual({
      content: [{ type: "text", text: "final answer text" }],
    });
  });
});
