CREATE TABLE `transcripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` text NOT NULL,
	`title` text NOT NULL,
	`raw_text` text NOT NULL,
	`summary` text NOT NULL,
	`participants` text DEFAULT '[]' NOT NULL,
	`action_items` text DEFAULT '[]' NOT NULL,
	`language` text,
	`svix_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_video_id_unique` ON `transcripts` (`video_id`);