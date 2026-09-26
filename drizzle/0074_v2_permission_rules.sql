-- Permissions overhaul ticket 06: rule-string storage for the v2 dispatcher.
-- Two tables: user-tier (no FK; user is a cloud-auth identity, not a sqlite row)
-- and project-tier (FK CASCADE on projects).
--
-- Rule strings are stored verbatim in claude-code grammar (`Bash(git push:*)`,
-- `Edit(src/**)`, `mcp__shortcut__*`). UNIQUE(scope_id, rule_string, rule_type)
-- is the dedup key — same rule_string with different rule_type coexists
-- intentionally so that allow + deny on the same pattern can both be stored
-- (the dispatcher's truth table resolves: deny wins).
--
-- 0.0.6 is local-only — no Neon mirror; cross-machine deferred to ~v0.0.50.
-- Hand-written (matches 0067 style) because drizzle/meta/ has a snapshot gap
-- post-0067 and drizzle-kit can silently strip inline CHECK constraints.

CREATE TABLE IF NOT EXISTS `user_permission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rule_string` text NOT NULL,
	`rule_type` text NOT NULL,
	`created_at` integer NOT NULL,
	CHECK (`rule_type` IN ('allow', 'deny', 'ask'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `upr_user_idx` ON `user_permission_rules` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `upr_unique_idx` ON `user_permission_rules` (
	`user_id`, `rule_string`, `rule_type`
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `project_permission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`rule_string` text NOT NULL,
	`rule_type` text NOT NULL,
	`created_at` integer NOT NULL,
	CHECK (`rule_type` IN ('allow', 'deny', 'ask')),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ppr_project_idx` ON `project_permission_rules` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ppr_unique_idx` ON `project_permission_rules` (
	`project_id`, `rule_string`, `rule_type`
);
