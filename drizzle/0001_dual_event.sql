-- Dual-event support: transcript and summary events both upsert into the
-- same row identified by video_id. New columns track Notion sync state so
-- we never double-create pages/followups when both events land.
--
-- raw_text and summary become nullable (each event populates one of them
-- on first arrival; the other UPDATEs in when its event fires).
--
-- SQLite doesn't support ALTER COLUMN, so we do the standard table-rebuild
-- dance. Safe because prod has no real rows yet.

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_transcripts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `video_id` text NOT NULL,
  `title` text NOT NULL,
  `raw_text` text,
  `summary` text,
  `bluedot_summary` text,
  `participants` text DEFAULT '[]' NOT NULL,
  `action_items` text DEFAULT '[]' NOT NULL,
  `language` text,
  `svix_id` text,
  `notion_page_id` text,
  `notion_synced_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint

INSERT INTO `__new_transcripts`
  (id, video_id, title, raw_text, summary, participants, action_items, language, svix_id, created_at)
SELECT id, video_id, title, raw_text, summary, participants, action_items, language, svix_id, created_at
FROM `transcripts`;--> statement-breakpoint

DROP TABLE `transcripts`;--> statement-breakpoint
ALTER TABLE `__new_transcripts` RENAME TO `transcripts`;--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_video_id_unique` ON `transcripts` (`video_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
