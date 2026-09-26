-- Local-first migration: tasks (chat / agent / shell work units).
--
-- Mirrors parked Neon migrations 0009 (title), 0027 (user_dispatched_idx),
-- 0030 (wait_mode/queue indexes), 0031 (pagination cursor indexes), 0034
-- (status redesign), 0037 (plan_ready), 0038 (flow_run_id + node_run_id),
-- 0052 (description nullable — we keep NOT NULL since the local create path
-- always supplies a description; backfill not needed for fresh-start migration).
--
-- Hand-written. Heartbeat columns omitted: single-process locally needs no
-- cross-process lease.

CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`title` text,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`execution_target` text DEFAULT 'local' NOT NULL,
	`requires_filesystem` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`trigger_context` text,
	`flow_run_id` text,
	`node_run_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`executed_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`flow_run_id`) REFERENCES `flow_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_user_status_created_idx` ON `tasks` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_user_executed_by_idx` ON `tasks` (`user_id`,`executed_by`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_flow_run_idx` ON `tasks` (`flow_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_node_run_unique` ON `tasks` (`node_run_id`) WHERE `node_run_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_idempotency_uniq` ON `tasks` (`user_id`,`source`,`source_id`) WHERE `source_id` IS NOT NULL;
