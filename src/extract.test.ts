import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EXTRACTION_SCHEMA,
  extractFromTranscript,
  type ExtractedSummary,
} from "./extract";

const fakeSummary: ExtractedSummary = {
  title: "Weekly sync",
  summary: "Discussed the roadmap and Q2 priorities.",
  action_items: [
    { task: "Send notes", owner: "Alice", due_date: "Friday" },
    { task: "Book conference room" },
  ],
  participants: [{ name: "Alice" }, { name: "Bob", email: "bob@x.com" }],
};

function fakeOpenAI(content: object | string, opts: { reject?: unknown } = {}) {
  const create = vi.fn(async () => {
    if (opts.reject) throw opts.reject;
    return {
      choices: [
        {
          message: {
            content: typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ],
    };
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

describe("EXTRACTION_SCHEMA", () => {
  it("requires title, summary, action_items, participants", () => {
    expect(EXTRACTION_SCHEMA.required).toEqual([
      "title",
      "summary",
      "action_items",
      "participants",
    ]);
  });

  it("disallows additionalProperties (strict)", () => {
    expect(EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("extractFromTranscript", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns parsed structured summary from OpenAI structured output", async () => {
    const { client, create } = fakeOpenAI(fakeSummary);

    const result = await extractFromTranscript(
      { title: "Weekly sync", transcript: "Alice: hi\nBob: hello" },
      { client, model: "gpt-4.1-nano" },
    );

    expect(result).toEqual(fakeSummary);
    expect(create).toHaveBeenCalledOnce();
    const args = (create.mock.calls[0] as never[])[0] as never as {
      model: string;
      response_format: { type: string; json_schema: { strict: boolean } };
    };
    expect(args.model).toBe("gpt-4.1-nano");
    expect(args.response_format.type).toBe("json_schema");
    expect(args.response_format.json_schema.strict).toBe(true);
  });

  it("includes attendees in user message when provided", async () => {
    const { client, create } = fakeOpenAI(fakeSummary);

    await extractFromTranscript(
      {
        title: "Sync",
        transcript: "Some content",
        attendees: [{ email: "alice@x.com" }],
      },
      { client },
    );

    const messages = ((create.mock.calls[0] as never[])[0] as { messages: Array<{ role: string; content: string }> }).messages;
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent).toContain("alice@x.com");
  });

  it("truncates very long transcripts", async () => {
    const { client, create } = fakeOpenAI(fakeSummary);
    const long = "a".repeat(200_000);

    await extractFromTranscript({ title: "Long", transcript: long }, { client });

    const messages = ((create.mock.calls[0] as never[])[0] as { messages: Array<{ role: string; content: string }> }).messages;
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    expect(userContent.length).toBeLessThan(160_000);
    expect(userContent).toContain("[truncated");
  });

  it("retries on 5xx errors and eventually succeeds", async () => {
    const err = Object.assign(new Error("server error"), { status: 503 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(fakeSummary) } }],
      });
    const client = { chat: { completions: { create } } } as never;

    const result = await extractFromTranscript(
      { title: "x", transcript: "y" },
      { client, retryDelayMs: 1 },
    );

    expect(result).toEqual(fakeSummary);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const { client, create } = fakeOpenAI({}, { reject: err });

    await expect(
      extractFromTranscript({ title: "x", transcript: "y" }, { client, retryDelayMs: 1 }),
    ).rejects.toThrow(/bad request/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("throws when OpenAI returns invalid JSON", async () => {
    const { client } = fakeOpenAI("not json {{");

    await expect(
      extractFromTranscript({ title: "x", transcript: "y" }, { client }),
    ).rejects.toThrow(/parse/i);
  });

  it("uses default model when not specified", async () => {
    const { client, create } = fakeOpenAI(fakeSummary);
    await extractFromTranscript({ title: "x", transcript: "y" }, { client });
    expect(((create.mock.calls[0] as never[])[0] as { model: string }).model).toBe("gpt-4.1-nano");
  });
});
