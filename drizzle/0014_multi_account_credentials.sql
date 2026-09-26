-- Multi-account Claude Code credentials (local SQLite only)
-- Stores OAuth tokens encrypted with machine-specific keys
-- Account labels and project mappings are synced via Neon

-- Add account_label column (nullable, app defaults to 'Claude Code' for existing)
ALTER TABLE `claude_code_credentials` ADD COLUMN `account_label` text;--> statement-breakpoint

-- Add is_default column (0 = not default, 1 = default)
ALTER TABLE `claude_code_credentials` ADD COLUMN `is_default` integer DEFAULT 0;--> statement-breakpoint

-- Set existing 'default' row as the default account
UPDATE `claude_code_credentials` SET `is_default` = 1, `account_label` = 'Claude Code' WHERE `id` = 'default';
