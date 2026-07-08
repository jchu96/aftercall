/**
 * Bluedot webhook payload shapes (observed empirically — no public schema).
 *
 * Bluedot fires multiple event types per meeting, distinguished by `type`.
 * We currently only act on `transcript` (it has the full text we need to
 * embed) and skip `summary` (Bluedot's own summary, not used — Claude
 * generates structured output from the transcript).
 */

export type BluedotEventType = "transcript" | "summary" | string;

export interface BluedotTranscriptUtterance {
  speaker: string;
  text: string;
}

export interface BluedotWebhookPayload {
  type: BluedotEventType;
  meetingId: string;
  videoId: string;
  title: string;
  createdAt?: number;
  duration?: number;
  attendees?: string[];
  transcript?: BluedotTranscriptUtterance[];
  summary?: string;
  summaryV2?: string;
  language?: string;
}

export interface NormalizedBluedotEvent {
  videoId: string;
  title: string;
  transcriptText: string;
  attendees: Array<{ email?: string; name?: string }>;
  language?: string;
  createdAt?: Date;
  meetingUrl?: string;
}

/**
 * Convert Bluedot's nested transcript array into a single labeled string
 * suitable for Claude summarization and OpenAI embeddings.
 */
export function flattenTranscript(utterances: BluedotTranscriptUtterance[]): string {
  return utterances
    .map((u) => {
      const speaker = (u.speaker ?? "").replace(/^Speaker:\s*/, "").trim();
      return speaker ? `${speaker}: ${u.text}` : u.text;
    })
    .join("\n");
}

/**
 * Derive a linkable meeting URL from Bluedot's `meetingId` (sometimes a URL
 * "https://meet.google.com/...", sometimes a schemeless path, sometimes an
 * opaque id). Used to link back to the meeting from Followup tasks and to
 * derive the `meeting_code` secondary index.
 */
function deriveMeetingUrl(payload: BluedotWebhookPayload): string | undefined {
  const rawMeetingId = payload.meetingId || payload.videoId;
  if (rawMeetingId.startsWith("http://") || rawMeetingId.startsWith("https://")) {
    return rawMeetingId;
  }
  if (rawMeetingId.includes("meet.google.com/") || rawMeetingId.includes("zoom.us/")) {
    return `https://${rawMeetingId}`;
  }
  return undefined;
}

/**
 * Map Bluedot's payload to our internal pipeline format.
 *
 * Uses `videoId` as the canonical id: it identifies the RECORDING and is
 * unique per call. `meetingId` identifies the ROOM — Google Meet reuses
 * codes across unrelated meetings, so keying on it silently drops any call
 * that lands on a recycled code (issue #5). Falls back to `meetingId` only
 * if videoId is missing (defensive — unobserved in practice).
 */
export function normalizeTranscriptEvent(payload: BluedotWebhookPayload): NormalizedBluedotEvent {
  if (!payload.transcript || payload.transcript.length === 0) {
    throw new Error("Bluedot transcript event missing transcript[] array");
  }

  return {
    videoId: payload.videoId || payload.meetingId,
    title: payload.title || "Untitled meeting",
    transcriptText: flattenTranscript(payload.transcript),
    attendees: (payload.attendees ?? []).map((email) => ({ email })),
    language: payload.language,
    createdAt: payload.createdAt ? new Date(payload.createdAt * 1000) : undefined,
    meetingUrl: deriveMeetingUrl(payload),
  };
}

/**
 * Bluedot's event type field has varied across sources (empirically observed):
 *   - `transcript` / `summary` (dashboard test-webhook button)
 *   - `video.transcript.created` / `video.summary.created` (Svix replays)
 *   - `meeting.transcript.created` / `meeting.summary.created` (live)
 */
export function isTranscriptEvent(payload: BluedotWebhookPayload): boolean {
  const t = payload.type ?? "";
  if (t.includes("summary")) return false;
  return t === "transcript" || t.endsWith(".transcript.created");
}

export function isSummaryEvent(payload: BluedotWebhookPayload): boolean {
  const t = payload.type ?? "";
  return t === "summary" || t.endsWith(".summary.created");
}

export interface NormalizedSummaryEvent {
  videoId: string;
  title: string;
  /** Bluedot's prose summary text (the input we pass to OpenAI) */
  summaryText: string;
  attendees: string[];
  createdAt?: Date;
  meetingUrl?: string;
}

export function normalizeSummaryEvent(
  payload: BluedotWebhookPayload & { summary?: string; summaryV2?: string },
): NormalizedSummaryEvent {
  const summaryText = payload.summaryV2 || payload.summary || "";
  if (!summaryText) {
    throw new Error("Bluedot summary event missing summary/summaryV2 text");
  }

  return {
    videoId: payload.videoId || payload.meetingId,
    title: payload.title || "Untitled meeting",
    summaryText,
    attendees: payload.attendees ?? [],
    createdAt: payload.createdAt ? new Date(payload.createdAt * 1000) : undefined,
    meetingUrl: deriveMeetingUrl(payload),
  };
}
