-- Local-first 0.0.5 priority #1: project ↔ AI / GitHub account routing tables.
--
-- Phase 1 chats migration moved chats.projectId to local cuid2 IDs but kept the
-- routing table (project_ai_accounts / project_github_accounts) in Neon. Every
-- per-project AI account lookup post-truncate has been hitting Neon with a local
-- ID that doesn't exist there, silently falling back to the default account.
-- Pulling the routing tables local fixes that and lets the workspace single-user
-- single-machine pivot stand on its own.
--
-- Adds:
--   - projects.description — was previously cloud-only metadata; needed locally
--     for AI-assisted descriptions on first add.
--   - project_ai_accounts (project_id, account_label) — routes a project to an
--     account label which then resolves against claude_code_credentials.
--   - project_github_accounts — same shape, for GitHub credential routing.
--
-- Cloud rows are NOT backfilled. They are keyed by Neon project IDs that no
-- longer exist post chats migration. User reconfigures routing in Settings.
--
-- Hand-written migration — drizzle's snapshot chain is stale (last regenerated at
-- 0005, see notes in 0064/0065). Running `drizzle-kit generate` would diff against
-- an out-of-date snapshot and emit destructive SQL.

ALTER TABLE `projects` ADD COLUMN `description` text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `project_ai_accounts` (
	`project_id` text NOT NULL,
	`account_label` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `project_github_accounts` (
	`project_id` text NOT NULL,
	`account_label` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `project_ai_accounts_project_label_idx`
	ON `project_ai_accounts` (`project_id`, `account_label`);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `project_github_accounts_project_label_idx`
	ON `project_github_accounts` (`project_id`, `account_label`);
