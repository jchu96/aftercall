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

describe("meeting_code population", () => {
  async function codeFor(videoId: string): Promise<string | null> {
    const row = await env.DB
      .prepare("SELECT meeting_code FROM transcripts WHERE video_id = ?1")
      .bind(videoId)
      .first<{ meeting_code: string | null }>();
    return row?.meeting_code ?? null;
  }

  it("derives meeting_code from video_id on transcript-event insert", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    expect(await codeFor(VIDEO_ID)).toBe("test");
  });

  it("derives meeting_code on summary-event insert", async () => {
    await upsertFromSummaryEvent(env.DB, summaryInput);
    expect(await codeFor(VIDEO_ID)).toBe("test");
  });

  it("both events for one meeting agree on meeting_code", async () => {
    await upsertFromTranscriptEvent(env.DB, transcriptInput);
    await upsertFromSummaryEvent(env.DB, summaryInput);
    expect(await codeFor(VIDEO_ID)).toBe("test");
  });

  it("prefers meetingUrl over video_id for meeting_code (hex recording id)", async () => {
    await upsertFromTranscriptEvent(env.DB, {
      ...transcriptInput,
      videoId: "6a4e745f7249289731dfa86c",
      meetingUrl: "https://meet.google.com/www-jjni-xtd",
    });
    expect(await codeFor("6a4e745f7249289731dfa86c")).toBe("www-jjni-xtd");
  });

  it("summary event also prefers meetingUrl for meeting_code", async () => {
    await upsertFromSummaryEvent(env.DB, {
      ...summaryInput,
      videoId: "6a4e745f7249289731dfa86c",
      meetingUrl: "https://meet.google.com/www-jjni-xtd",
    });
    expect(await codeFor("6a4e745f7249289731dfa86c")).toBe("www-jjni-xtd");
  });
});

describe("reused Meet code (issue #5)", () => {
  it("two recordings in the same room insert as distinct rows sharing a meeting_code", async () => {
    const room = "https://meet.google.com/www-jjni-xtd";
    const june = await upsertFromTranscriptEvent(env.DB, {
      ...transcriptInput,
      videoId: "5f1c2233445566778899aabb",
      meetingUrl: room,
      title: "Design tool soft launch",
    });
    const july = await upsertFromTranscriptEvent(env.DB, {
      ...transcriptInput,
      videoId: "6a4e745f7249289731dfa86c",
      meetingUrl: room,
      title: "Design tool soft launch",
    });

    expect(june.inserted).toBe(true);
    expect(july.inserted).toBe(true);
    expect(july.transcriptId).not.toBe(june.transcriptId);

    const { results } = await env.DB
      .prepare("SELECT video_id, meeting_code FROM transcripts WHERE meeting_code = ?1")
      .bind("www-jjni-xtd")
      .all<{ video_id: string; meeting_code: string }>();
    expect(results).toHaveLength(2);
  });
});
