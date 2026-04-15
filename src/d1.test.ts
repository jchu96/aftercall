import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  upsertFromTranscriptEvent,
  upsertFromSummaryEvent,
  markNotionSynced,
  type TranscriptEventInput,
  type SummaryEventInput,
} from "./d1";
import { setupD1 } from "../test/setup-d1";

beforeEach(async () => {
  await setupD1();
});

const VIDEO_ID = "https://meet.google.com/test";

const transcriptInput: TranscriptEventInput = {
  videoId: VIDEO_ID,
  svixId: "msg_t",
  title: "Test sync",
  rawText: "Alice: hi\nBob: hello",
  participants: [{ email: "a@x.com" }, { email: "b@x.com" }],
  language: "en",
};

const summaryInput: SummaryEventInput = {
  videoId: VIDEO_ID,
  svixId: "msg_s",
  title: "Test sync",
  bluedotSummary: "Discussed Q2 priorities.",
  summary: "Discussed Q2 priorities.",
  participants: [{ name: "Alice" }, { name: "Bob", role: "PM" }],
  actionItems: [
    { task: "Send notes", owner: "Alice", due_date: "Friday" },
    { task: "Book room" },
  ],
};

describe("upsertFromTranscriptEvent", () => {
  it("inserts a new row when none exists", async () => {
    const r = await upsertFromTranscriptEvent(env.DB, transcriptInput);
    expect(r.inserted).toBe(true);
    expect(r.bothEventsPresent).toBe(false);
    expect(r.alreadyNotionSynced).toBe(false);
  });

  it("is idempotent on retry — second call sees existing row", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    const r = await upsertFromTranscriptEvent(env.DB, transcriptInput);
    expect(r.inserted).toBe(false);
  });

  it("after summary event arrived first, sets bothEventsPresent: true", async () => {
    await upsertFromSummaryEvent(env.DB, summaryInput);
    const r = await upsertFromTranscriptEvent(env.DB, transcriptInput);
    expect(r.inserted).toBe(false);
    expect(r.bothEventsPresent).toBe(true);
  });
});

describe("upsertFromSummaryEvent", () => {
  it("inserts a new row when none exists", async () => {
    const r = await upsertFromSummaryEvent(env.DB, summaryInput);
    expect(r.inserted).toBe(true);
    expect(r.bothEventsPresent).toBe(false);
  });

  it("is idempotent on retry", async () => {
    await upsertFromSummaryEvent(env.DB, summaryInput);
    const r = await upsertFromSummaryEvent(env.DB, summaryInput);
    expect(r.inserted).toBe(false);
  });

  it("after transcript event arrived first, sets bothEventsPresent: true", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    const r = await upsertFromSummaryEvent(env.DB, summaryInput);
    expect(r.inserted).toBe(false);
    expect(r.bothEventsPresent).toBe(true);
  });

  it("preserves raw_text from earlier transcript event", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    await upsertFromSummaryEvent(env.DB, summaryInput);
    const row = await env.DB
      .prepare("SELECT raw_text, summary, action_items FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ raw_text: string; summary: string; action_items: string }>();
    expect(row?.raw_text).toBe("Alice: hi\nBob: hello");
    expect(row?.summary).toBe("Discussed Q2 priorities.");
    expect(JSON.parse(row!.action_items)).toHaveLength(2);
  });
});

describe("markNotionSynced", () => {
  it("returns true when transitioning from unsynced to synced", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    const row = await env.DB
      .prepare("SELECT id FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ id: number }>();
    const ok = await markNotionSynced(env.DB, row!.id, "page_xyz");
    expect(ok).toBe(true);
  });

  it("returns false on second call (already synced)", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    const row = await env.DB
      .prepare("SELECT id FROM transcripts WHERE video_id = ?")
      .bind(VIDEO_ID)
      .first<{ id: number }>();
    await markNotionSynced(env.DB, row!.id, "page_xyz");
    const second = await markNotionSynced(env.DB, row!.id, "page_xyz");
    expect(second).toBe(false);
  });
});
