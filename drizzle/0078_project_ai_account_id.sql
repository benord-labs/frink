-- Per-project AI account override: key on claude_code_credentials.id, not account_label.
--
-- account_label has no unique index — two providers can both be labelled "Personal"
-- (e.g. one Claude Code, one Codex). A label-keyed override therefore could not name a
-- single credential row, so every reader guessed with an ORDER BY heuristic and could
-- resolve a different account than the user picked. `id` is the primary key, so the
-- override becomes exact. The FK below also makes it self-cleaning on account delete
-- and makes a dangling override impossible to insert.
--
-- SQLite cannot add a foreign key to an existing table, so the table is recreated.
-- Existing rows are DROPPED rather than mapped label -> id: a backfill would need the
-- same ambiguous tie-break this migration removes, and would bind the wrong account in
-- exactly the duplicate-label case that motivated it. Projects without a row fall back
-- to the workspace default; re-pick in Settings > project > Worktree Setup > AI Account.
--
-- The old index was UNIQUE(project_id, account_label), which permitted several rows per
-- project — one-per-project was enforced only by the writer's delete-then-insert.
-- UNIQUE(project_id) moves that invariant into the schema.
--
-- Hand-written migration — drizzle's snapshot chain is stale (last regenerated at 0005,
-- see notes in 0064/0065/0066). Running `drizzle-kit generate` would diff against an
-- out-of-date snapshot and emit destructive SQL.

DROP TABLE IF EXISTS `project_ai_accounts`;--> statement-breakpoint

CREATE TABLE `project_ai_accounts` (
	`project_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `claude_code_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE UNIQUE INDEX `project_ai_accounts_project_idx` ON `project_ai_accounts` (`project_id`);
