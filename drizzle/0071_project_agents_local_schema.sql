-- Local-first migration: project_agents (per-project enable/disable + config
-- overrides for filesystem-discovered agents/skills/hooks).
--
-- Phase 2 finish-list #3. Hand-written. Mirrors parked Neon migration 0020,
-- adapted for local cuid2 PKs:
-- - id is text (cuid2) not UUID.
-- - project_id is text (cuid2) referencing local projects(id).
-- - timestamps are integer (unix ms) per Drizzle SQLite mode 'timestamp'.
-- - CHECK constraint on type narrows to ('agent','skill','hook').
-- - Composite UNIQUE matches cloud index.

CREATE TABLE IF NOT EXISTS `project_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`config_overrides` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`type` IN ('agent','skill','hook'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `project_agents_unique_idx` ON `project_agents` (`project_id`,`agent_name`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_agents_project_idx` ON `project_agents` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `project_agents_enabled_idx` ON `project_agents` (`project_id`) WHERE `enabled` = 1;
