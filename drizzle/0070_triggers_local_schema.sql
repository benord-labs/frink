-- Local-first migration: trigger source group (user_integrations + flow_trigger_bindings).
--
-- Phase 2 finish-list #1. Hand-written. Mirrors Neon migrations referenced by
-- socket-server but narrowed per design doc:
-- - integration_webhooks STAYS cloud (stable public addressing returns in 3b
--   per design §119–131).
-- - trigger_rules STAYS cloud (no v1 consumer).
-- - Provider enum narrowed to ('shortcut','github') v1 — Slack/ClickUp/Gmail
--   are webhook-driven and gated on LAUNCH_FLAGS.crossMachineTriggers.
-- - flow_trigger_bindings.trigger_type narrowed to ('post_task_trigger',
--   'schedule_trigger') — webhook_trigger rejected at repo write time.

CREATE TABLE IF NOT EXISTS `user_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`account_name` text,
	`account_identifier` text NOT NULL,
	`api_token_encrypted` text,
	`nango_connection_id` text,
	`external_user_id` text,
	`external_workspace_id` text,
	`external_workspace_name` text,
	`gmail_last_history_id` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`provider` IN ('shortcut','github'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_integrations_user_idx` ON `user_integrations` (`user_id`,`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_integrations_user_provider_workspace_uq` ON `user_integrations` (`user_id`,`provider`,COALESCE(`external_workspace_id`,`external_user_id`,`account_identifier`)) WHERE `is_active` = 1;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `flow_trigger_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`project_id` text,
	`trigger_type` text NOT NULL,
	`config` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (`trigger_type` IN ('post_task_trigger','schedule_trigger'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_trigger_bindings_user_active_idx` ON `flow_trigger_bindings` (`user_id`,`is_active`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_trigger_bindings_flow_idx` ON `flow_trigger_bindings` (`flow_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_trigger_bindings_type_active_idx` ON `flow_trigger_bindings` (`trigger_type`,`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_trigger_bindings_uq` ON `flow_trigger_bindings` (`user_id`,`flow_id`,COALESCE(`project_id`,''),`trigger_type`) WHERE `is_active` = 1;
