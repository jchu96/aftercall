import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { writeTranscript, type TranscriptWriteInput } from "./d1";
import { setupD1 } from "../test/setup-d1";

beforeEach(async () => {
  await setupD1();
});

const baseInput: TranscriptWriteInput = {
  videoId: "vid_abc",
  svixId: "msg_abc",
  title: "Test call",
  rawText: "hello world",
  summary: "we said hello",
  participants: [{ name: "Jeremy" }],
  actionItems: [{ task: "follow up" }],
  language: "en",
};

describe("writeTranscript (against real D1)", () => {
  it("inserts a new transcript and returns the row id", async () => {
    const result = await writeTranscript(env.DB, baseInput);

    expect(result.inserted).toBe(true);
    expect(typeof result.transcriptId).toBe("number");

    const row = await env.DB
      .prepare("SELECT id, video_id, title FROM transcripts WHERE video_id = ?")
      .bind(baseInput.videoId)
      .first();
    expect(row).toMatchObject({ video_id: "vid_abc", title: "Test call" });
  });

  it("is idempotent — second insert with same video_id returns inserted: false", async () => {
    const first = await writeTranscript(env.DB, baseInput);
    const second = await writeTranscript(env.DB, baseInput);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.transcriptId).toBeUndefined();

    const { results } = await env.DB
      .prepare("SELECT COUNT(*) as count FROM transcripts WHERE video_id = ?")
      .bind(baseInput.videoId)
      .all();
    expect(results[0].count).toBe(1);
  });

  it("serializes participants and action_items as JSON", async () => {
    const result = await writeTranscript(env.DB, {
      ...baseInput,
      videoId: "vid_json",
      participants: [{ name: "Alice", email: "a@x.com" }, { name: "Bob" }],
      actionItems: [
        { task: "Send notes", owner: "Alice", due_date: "Friday" },
      ],
    });

    const row = await env.DB
      .prepare("SELECT participants, action_items FROM transcripts WHERE id = ?")
      .bind(result.transcriptId!)
      .first();

    const participants = JSON.parse(row!.participants as string);
    const actionItems = JSON.parse(row!.action_items as string);

    expect(participants).toEqual([
      { name: "Alice", email: "a@x.com" },
      { name: "Bob" },
    ]);
    expect(actionItems).toEqual([
      { task: "Send notes", owner: "Alice", due_date: "Friday" },
    ]);
  });

  it("handles missing optional language", async () => {
    const result = await writeTranscript(env.DB, {
      ...baseInput,
      videoId: "vid_nolang",
      language: undefined,
    });

    const row = await env.DB
      .prepare("SELECT language FROM transcripts WHERE id = ?")
      .bind(result.transcriptId!)
      .first();
    expect(row!.language).toBeNull();
  });
});
