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

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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

export const transcripts = sqliteTable("transcripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  videoId: text("video_id").notNull().unique(),
  title: text("title").notNull(),
  rawText: text("raw_text").notNull(),
  summary: text("summary").notNull(),
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
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
