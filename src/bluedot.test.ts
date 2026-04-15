import { describe, it, expect } from "vitest";
import {
  flattenTranscript,
  normalizeTranscriptEvent,
  normalizeSummaryEvent,
  isTranscriptEvent,
  isSummaryEvent,
  type BluedotWebhookPayload,
} from "./bluedot";

const SAMPLE: BluedotWebhookPayload = {
  type: "transcript",
  meetingId: "meet.google.com/vtf-wvmj-utp",
  videoId: "v1",
  title: "Founder chat",
  createdAt: 1741088306,
  duration: 53.6,
  attendees: ["alice@example.com", "bob@example.com"],
  transcript: [
    { speaker: "Speaker: A", text: "How are you?" },
    { speaker: "Speaker: B", text: "Doing well." },
  ],
};

describe("flattenTranscript", () => {
  it("joins utterances with speaker labels", () => {
    expect(
      flattenTranscript([
        { speaker: "Speaker: A", text: "Hi" },
        { speaker: "Speaker: B", text: "Hello" },
      ]),
    ).toBe("A: Hi\nB: Hello");
  });

  it("handles missing speaker", () => {
    expect(flattenTranscript([{ speaker: "", text: "lonely" }])).toBe("lonely");
  });
});

describe("normalizeTranscriptEvent", () => {
  it("maps Bluedot fields to internal model", () => {
    const result = normalizeTranscriptEvent(SAMPLE);

    expect(result.videoId).toBe("meet.google.com/vtf-wvmj-utp");
    expect(result.title).toBe("Founder chat");
    expect(result.transcriptText).toBe("A: How are you?\nB: Doing well.");
    expect(result.attendees).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
    expect(result.createdAt?.toISOString()).toBe("2025-03-04T11:38:26.000Z");
  });

  it("falls back to videoId if meetingId missing", () => {
    const r = normalizeTranscriptEvent({ ...SAMPLE, meetingId: "" });
    expect(r.videoId).toBe("v1");
  });

  it("throws when transcript is empty", () => {
    expect(() =>
      normalizeTranscriptEvent({ ...SAMPLE, transcript: [] }),
    ).toThrow(/missing transcript/i);
  });
});

describe("isTranscriptEvent", () => {
  it("matches transcript variants", () => {
    expect(isTranscriptEvent(SAMPLE)).toBe(true);
    expect(isTranscriptEvent({ ...SAMPLE, type: "video.transcript.created" })).toBe(true);
    expect(isTranscriptEvent({ ...SAMPLE, type: "meeting.transcript.created" })).toBe(true);
  });

  it("rejects summary variants", () => {
    expect(isTranscriptEvent({ ...SAMPLE, type: "summary" })).toBe(false);
    expect(isTranscriptEvent({ ...SAMPLE, type: "meeting.summary.created" })).toBe(false);
  });
});

describe("isSummaryEvent", () => {
  it("matches summary variants", () => {
    expect(isSummaryEvent({ ...SAMPLE, type: "summary" })).toBe(true);
    expect(isSummaryEvent({ ...SAMPLE, type: "video.summary.created" })).toBe(true);
    expect(isSummaryEvent({ ...SAMPLE, type: "meeting.summary.created" })).toBe(true);
  });

  it("rejects transcript variants", () => {
    expect(isSummaryEvent(SAMPLE)).toBe(false);
    expect(isSummaryEvent({ ...SAMPLE, type: "meeting.transcript.created" })).toBe(false);
  });
});

describe("normalizeSummaryEvent", () => {
  const SUMMARY_SAMPLE = {
    type: "meeting.summary.created",
    meetingId: "https://meet.google.com/test",
    videoId: "v1",
    title: "Sync",
    createdAt: 1741087081,
    attendees: ["a@x.com"],
    summary: "Discussed Q2 priorities and Hannah promotion.",
  };

  it("uses summaryV2 when present, falls back to summary", () => {
    const r1 = normalizeSummaryEvent({ ...SUMMARY_SAMPLE, summaryV2: "## V2 markdown" });
    expect(r1.summaryText).toBe("## V2 markdown");
    const r2 = normalizeSummaryEvent(SUMMARY_SAMPLE);
    expect(r2.summaryText).toBe("Discussed Q2 priorities and Hannah promotion.");
  });

  it("extracts meetingUrl when meetingId is a URL", () => {
    const r = normalizeSummaryEvent(SUMMARY_SAMPLE);
    expect(r.meetingUrl).toBe("https://meet.google.com/test");
  });

  it("throws when both summary and summaryV2 missing", () => {
    expect(() =>
      normalizeSummaryEvent({ ...SUMMARY_SAMPLE, summary: undefined }),
    ).toThrow(/missing summary/i);
  });
});
