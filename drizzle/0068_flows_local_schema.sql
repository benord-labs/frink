-- Local-first migration: Frink Flows.
--
-- Adds local SQLite tables that mirror parked Neon flows migrations:
--   - flows                  ← _neon-parked/0038, 0046, 0051
--   - flow_versions          ← _neon-parked/0038, 0040
--   - flow_runs              ← _neon-parked/0038, 0039, 0055, 0061
--   - node_runs              ← _neon-parked/0038, 0041, 0050 (lease cols 0048 omitted)
--   - flow_kv_state          ← _neon-parked/0043
--   - briefing_stashes       ← _neon-parked/0056
--   - batch_plan_templates   ← _neon-parked/0060
--   - batch_stages           ← _neon-parked/0058, 0059
--   - batch_stage_runs       ← _neon-parked/0058
--
-- Hand-written. Cuid2 IDs (TEXT). user_id is text — single-user-per-machine; cloud
-- users FK omitted. JSON columns stored as TEXT. Partial unique indexes on
-- idempotency_key (NULL allowed many times) and node_runs running uniqueness.

CREATE TABLE IF NOT EXISTS `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`description` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`agent_invocable` integer DEFAULT false NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flows_user_idx` ON `flows` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flows_project_idx` ON `flows` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `flow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`graph` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_versions_flow_version_uniq` ON `flow_versions` (`flow_id`,`version_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_versions_flow_idx` ON `flow_versions` (`flow_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `flow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger_context` text,
	`idempotency_key` text,
	`batch_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer,
	FOREIGN KEY (`flow_version_id`) REFERENCES `flow_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_runs_idempotency_uniq` ON `flow_runs` (`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_runs_user_status_idx` ON `flow_runs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_runs_version_created_idx` ON `flow_runs` (`flow_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_runs_batch_idx` ON `flow_runs` (`batch_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`block_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`node_output` text,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`lane_index` integer,
	`parent_fan_out_node_run_id` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer,
	FOREIGN KEY (`flow_run_id`) REFERENCES `flow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `node_runs_flow_run_idx` ON `node_runs` (`flow_run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `node_runs_parent_fan_out_idx` ON `node_runs` (`parent_fan_out_node_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `node_runs_unique_running` ON `node_runs` (`flow_run_id`,`node_id`,`lane_index`) WHERE status = 'running';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `flow_kv_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '{}' NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_kv_state_uniq` ON `flow_kv_state` (`user_id`,`flow_id`,`key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_kv_state_lookup_idx` ON `flow_kv_state` (`user_id`,`flow_id`,`key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `briefing_stashes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`source_flow_id` text,
	`source_flow_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `briefing_stashes_user_idx` ON `briefing_stashes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `batch_plan_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`stages` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`source_flow_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `batch_plan_templates_user_name_uniq` ON `batch_plan_templates` (`user_id`, lower(`name`));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `batch_plan_templates_user_idx` ON `batch_plan_templates` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `batch_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`stage_number` integer NOT NULL,
	`name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`failure_threshold` integer DEFAULT 0 NOT NULL,
	`depends_on_stage_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `batch_stages_batch_stage_uniq` ON `batch_stages` (`batch_id`,`stage_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `batch_stages_batch_idx` ON `batch_stages` (`batch_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `batch_stage_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`stage_id` text NOT NULL,
	`flow_run_id` text,
	`trigger_context` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`stage_id`) REFERENCES `batch_stages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `batch_stage_runs_stage_status_idx` ON `batch_stage_runs` (`stage_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `batch_stage_runs_flow_run_idx` ON `batch_stage_runs` (`flow_run_id`);
