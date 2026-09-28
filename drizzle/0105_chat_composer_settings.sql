-- Composer settings move into main so the phone and every window share them.
-- NULL = never set: defaults resolve in code, and the one-time import fills only NULLs.
ALTER TABLE `chats` ADD COLUMN `composer_model_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD COLUMN `composer_auto_mode` integer;--> statement-breakpoint
ALTER TABLE `chats` ADD COLUMN `composer_codex_fast` integer;--> statement-breakpoint
-- App-wide preferences main must read (e.g. the global Thinking switch). Values are JSON text.
CREATE TABLE IF NOT EXISTS `app_preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
