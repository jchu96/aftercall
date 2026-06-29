ALTER TABLE `transcripts` ADD `meeting_code` text;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `chunk_count` integer;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `chunk_schema_version` integer;--> statement-breakpoint
CREATE INDEX `idx_transcripts_meeting_code` ON `transcripts` (`meeting_code`);