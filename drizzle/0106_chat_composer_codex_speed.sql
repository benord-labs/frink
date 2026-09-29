-- The per-chat Codex Fast switch becomes a speed name so a further tier needs no new column.
-- 1 → 'fast', 0 → 'standard'; NULL (never set) stays NULL.
ALTER TABLE `chats` ADD COLUMN `composer_codex_speed` text;--> statement-breakpoint
UPDATE `chats` SET `composer_codex_speed` = CASE `composer_codex_fast` WHEN 1 THEN 'fast' WHEN 0 THEN 'standard' END WHERE `composer_codex_fast` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `composer_codex_fast`;
