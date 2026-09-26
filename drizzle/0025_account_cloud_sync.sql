-- Account Cloud Sync: make oauth_token nullable, add cloud_account_id, add retry queue
-- Enables cross-machine account metadata sync via Neon

-- Step 1: Full table rebuild to make oauth_token nullable and add cloud_account_id
-- SQLite ALTER TABLE cannot change NOT NULL constraints, so we rebuild the table
DROP TABLE IF EXISTS `claude_code_credentials_new`;--> statement-breakpoint
CREATE TABLE `claude_code_credentials_new` (
  `id` text PRIMARY KEY NOT NULL,
  `type` text NOT NULL DEFAULT 'claude-code',
  `account_label` text,
  `oauth_token` text,
  `connected_at` integer,
  `user_id` text,
  `is_default` integer DEFAULT 0,
  `cloud_account_id` text
);--> statement-breakpoint
INSERT INTO `claude_code_credentials_new`
  SELECT id, type, account_label, oauth_token, connected_at, user_id, is_default, NULL
  FROM `claude_code_credentials`;--> statement-breakpoint
DROP TABLE `claude_code_credentials`;--> statement-breakpoint
ALTER TABLE `claude_code_credentials_new` RENAME TO `claude_code_credentials`;--> statement-breakpoint

-- Step 2: Retry queue for failed Neon account syncs (IF NOT EXISTS — may exist from prior defensive init)
CREATE TABLE IF NOT EXISTS `pending_account_syncs` (
  `id` text PRIMARY KEY NOT NULL,
  `operation` text NOT NULL,
  `account_label` text NOT NULL,
  `account_type` text,
  `old_label` text,
  `cloud_account_id` text,
  `created_at` integer DEFAULT (unixepoch()),
  `retry_count` integer DEFAULT 0
);
