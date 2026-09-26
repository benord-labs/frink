-- Add type column to support Cursor CLI alongside Claude Code (Phase 9)
-- type: 'claude-code' | 'cursor'; existing rows default to 'claude-code'

ALTER TABLE `claude_code_credentials` ADD COLUMN `type` text DEFAULT 'claude-code';--> statement-breakpoint
UPDATE `claude_code_credentials` SET `type` = 'claude-code' WHERE `type` IS NULL;
