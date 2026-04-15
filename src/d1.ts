import type { ActionItem, Participant } from "./schema";

export interface TranscriptEventInput {
  videoId: string;
  svixId: string;
  title: string;
  rawText: string;
  participants: Participant[];
  language?: string;
}

export interface SummaryEventInput {
  videoId: string;
  svixId: string;
  title: string;
  bluedotSummary: string;
  summary: string;
  participants: Participant[];
  actionItems: ActionItem[];
}

export interface UpsertResult {
  inserted: boolean;
  transcriptId: number;
  /** Did THIS upsert just complete the row (both transcript + summary now present)? */
  bothEventsPresent: boolean;
  alreadyNotionSynced: boolean;
}

/**
 * Mark Notion sync complete so we never double-post.
 * Returns true if marked (was previously null), false if already marked.
 */
export async function markNotionSynced(
  db: D1Database,
  transcriptId: number,
  pageId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE transcripts
       SET notion_page_id = ?1, notion_synced_at = datetime('now')
       WHERE id = ?2 AND notion_synced_at IS NULL`,
    )
    .bind(pageId, transcriptId)
    .run();
  return result.meta.changes > 0;
}

interface RowState {
  id: number;
  raw_text: string | null;
  summary: string | null;
  notion_synced_at: string | null;
}

/**
 * Upsert from a transcript event. Idempotent against retries.
 *
 * - If row missing: INSERT with raw_text + title + language + participants
 * - If row exists: UPDATE raw_text + language (don't clobber summary fields)
 *
 * Returns `bothEventsPresent: true` when both raw_text and summary are now
 * set, signaling the caller can do Notion writes.
 */
export async function upsertFromTranscriptEvent(
  db: D1Database,
  input: TranscriptEventInput,
): Promise<UpsertResult> {
  // Try insert first (most common case)
  const inserted = await db
    .prepare(
      `INSERT INTO transcripts (video_id, title, raw_text, language, participants, svix_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (video_id) DO NOTHING
       RETURNING id`,
    )
    .bind(
      input.videoId,
      input.title,
      input.rawText,
      input.language ?? null,
      JSON.stringify(input.participants),
      input.svixId,
    )
    .first<{ id: number } | null>();

  if (inserted) {
    return {
      inserted: true,
      transcriptId: inserted.id,
      bothEventsPresent: false, // summary not present yet
      alreadyNotionSynced: false,
    };
  }

  // Row exists — UPDATE the transcript-side fields if they're missing
  const existing = await db
    .prepare(
      `SELECT id, raw_text, summary, notion_synced_at FROM transcripts WHERE video_id = ?1`,
    )
    .bind(input.videoId)
    .first<RowState>();

  if (!existing) {
    throw new Error(`Race condition: row vanished after conflict for ${input.videoId}`);
  }

  if (existing.raw_text == null) {
    await db
      .prepare(
        `UPDATE transcripts
         SET raw_text = ?1, language = COALESCE(language, ?2),
             participants = CASE WHEN participants = '[]' THEN ?3 ELSE participants END
         WHERE id = ?4`,
      )
      .bind(
        input.rawText,
        input.language ?? null,
        JSON.stringify(input.participants),
        existing.id,
      )
      .run();
  }

  return {
    inserted: false,
    transcriptId: existing.id,
    bothEventsPresent: existing.summary != null,
    alreadyNotionSynced: existing.notion_synced_at != null,
  };
}

/**
 * Upsert from a summary event. Idempotent against retries.
 *
 * - If row missing: INSERT with summary + bluedot_summary + action_items + title
 * - If row exists: UPDATE summary + action_items (don't clobber raw_text)
 *
 * Action items here came from running OpenAI on Bluedot's summary text.
 */
export async function upsertFromSummaryEvent(
  db: D1Database,
  input: SummaryEventInput,
): Promise<UpsertResult> {
  const inserted = await db
    .prepare(
      `INSERT INTO transcripts
         (video_id, title, summary, bluedot_summary, participants, action_items, svix_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (video_id) DO NOTHING
       RETURNING id`,
    )
    .bind(
      input.videoId,
      input.title,
      input.summary,
      input.bluedotSummary,
      JSON.stringify(input.participants),
      JSON.stringify(input.actionItems),
      input.svixId,
    )
    .first<{ id: number } | null>();

  if (inserted) {
    return {
      inserted: true,
      transcriptId: inserted.id,
      bothEventsPresent: false, // transcript event not yet
      alreadyNotionSynced: false,
    };
  }

  const existing = await db
    .prepare(
      `SELECT id, raw_text, summary, notion_synced_at FROM transcripts WHERE video_id = ?1`,
    )
    .bind(input.videoId)
    .first<RowState>();

  if (!existing) {
    throw new Error(`Race condition: row vanished after conflict for ${input.videoId}`);
  }

  if (existing.summary == null) {
    await db
      .prepare(
        `UPDATE transcripts
         SET summary = ?1, bluedot_summary = ?2, action_items = ?3,
             participants = CASE WHEN participants = '[]' THEN ?4 ELSE participants END
         WHERE id = ?5`,
      )
      .bind(
        input.summary,
        input.bluedotSummary,
        JSON.stringify(input.actionItems),
        JSON.stringify(input.participants),
        existing.id,
      )
      .run();
  }

  return {
    inserted: false,
    transcriptId: existing.id,
    bothEventsPresent: existing.raw_text != null,
    alreadyNotionSynced: existing.notion_synced_at != null,
  };
}
