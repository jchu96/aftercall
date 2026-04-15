import type { ActionItem, Participant } from "./schema";

export interface TranscriptWriteInput {
  videoId: string;
  svixId: string;
  title: string;
  rawText: string;
  summary: string;
  participants: Participant[];
  actionItems: ActionItem[];
  language?: string;
}

export interface WriteResult {
  inserted: boolean;
  transcriptId?: number;
}

/**
 * Idempotent insert into D1 transcripts table.
 *
 * Uses raw SQL via D1 prepared statements rather than Drizzle, because
 * Drizzle's `.onConflictDoNothing().returning()` typing on D1 has had
 * bugs and SQLite syntax is straightforward enough not to need an ORM
 * for this. Embeddings live in Vectorize, not D1 — keyed by transcript_id.
 */
export async function writeTranscript(
  db: D1Database,
  input: TranscriptWriteInput,
): Promise<WriteResult> {
  const stmt = db
    .prepare(
      `INSERT INTO transcripts
         (video_id, title, raw_text, summary, participants, action_items, language, svix_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (video_id) DO NOTHING
       RETURNING id`,
    )
    .bind(
      input.videoId,
      input.title,
      input.rawText,
      input.summary,
      JSON.stringify(input.participants),
      JSON.stringify(input.actionItems),
      input.language ?? null,
      input.svixId,
    );

  const row = await stmt.first<{ id: number } | null>();

  if (!row) {
    return { inserted: false };
  }
  return { inserted: true, transcriptId: row.id };
}
