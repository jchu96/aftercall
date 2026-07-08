/**
 * D1 (SQLite) schema for transcripts.
 *
 * Embeddings live in Cloudflare Vectorize, NOT in this table.
 * Vector IDs are deterministic: `${transcript_id}-${chunk_index}`.
 *
 * JSON columns (`participants`, `action_items`) are stored as text and
 * deserialized at the application layer. SQLite supports `json_each` etc.
 * if we ever need to query into them.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export interface ActionItem {
  task: string;
  owner?: string;
  due_date?: string;
}

export interface Participant {
  name?: string;
  email?: string;
  role?: string;
}

/**
 * Transcripts table — populated by two Bluedot events that fire ~13s apart
 * for the same meetingId. Each event upserts the row with its own data.
 *
 * - meeting.transcript.created → raw_text, language, participants_basic
 * - meeting.summary.created    → summary (Bluedot), action_items (extracted)
 *
 * Notion writes (transcript page + followups) only happen once both have
 * arrived AND notion_synced_at is null. Tracked here so we never double-post.
 */
export const transcripts = sqliteTable("transcripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /**
   * Bluedot's per-RECORDING id (`payload.videoId`, hex) — the uniqueness /
   * idempotency key. Never the meeting URL: Meet codes identify a room and
   * are reused across unrelated meetings (issue #5). Legacy rows ingested
   * before the fix hold the URL form; both resolve via `meeting_code`.
   */
  videoId: text("video_id").notNull().unique(),
  title: text("title").notNull(),
  rawText: text("raw_text"),
  summary: text("summary"),
  bluedotSummary: text("bluedot_summary"),
  participants: text("participants", { mode: "json" })
    .$type<Participant[]>()
    .notNull()
    .default(sql`'[]'`),
  actionItems: text("action_items", { mode: "json" })
    .$type<ActionItem[]>()
    .notNull()
    .default(sql`'[]'`),
  language: text("language"),
  svixId: text("svix_id"),
  notionPageId: text("notion_page_id"),
  notionSyncedAt: text("notion_synced_at"),
  /**
   * Canonical, normalized meeting identifier derived from the room URL
   * (Bluedot `meetingId`), falling back to `video_id` for legacy/opaque
   * payloads. Indexed non-unique — reused Meet codes and recurring meetings
   * legitimately map many recordings to one code; the resolver disambiguates
   * downstream (newest first). Lets a pasted Meet URL, a schemeless path,
   * and a bare code all resolve the same call.
   */
  meetingCode: text("meeting_code"),
  /** Number of chunks embedded into Vectorize for this transcript. */
  chunkCount: integer("chunk_count"),
  /**
   * Chunking algorithm version. v2 = turn-aware (speaker-labeled) chunks.
   * Rows below the current version are swept by `scripts/reindex-transcripts.ts`.
   */
  chunkSchemaVersion: integer("chunk_schema_version"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_transcripts_meeting_code").on(table.meetingCode),
]);

export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
