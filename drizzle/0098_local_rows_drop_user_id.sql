-- Local rows belong to the one owner of this userData directory, so the identity column and the
-- cloud-account sync it fed are removed. Any index naming a column blocks DROP COLUMN in SQLite,
-- so every table below reconciles its data, drops its indexes, drops the column, then recreates
-- the narrowed replacements.

-- ============ claude_code_credentials ============
-- Per-project overrides are repointed onto the surviving duplicate first: account_id cascades on
-- delete, so an unrepointed override would vanish with the row it names.
UPDATE `project_ai_accounts` SET `account_id` = (
	SELECT `k`.`id` FROM `claude_code_credentials` `k`, `claude_code_credentials` `d`
	WHERE `d`.`id` = `project_ai_accounts`.`account_id`
		AND `k`.`type` = `d`.`type`
		AND `k`.`source` = `d`.`source`
		AND COALESCE(`k`.`account_label`, '') = COALESCE(`d`.`account_label`, '')
	ORDER BY `k`.`rowid` LIMIT 1
) WHERE `account_id` IN (SELECT `id` FROM `claude_code_credentials`);--> statement-breakpoint
DELETE FROM `claude_code_credentials` WHERE `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `claude_code_credentials`
	GROUP BY `type`, `source`, COALESCE(`account_label`, '')
);--> statement-breakpoint
-- The user_id predicate was the only thing keeping two rows of one provider both default.
UPDATE `claude_code_credentials` SET `is_default` = 0 WHERE `is_default` = 1 AND `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `claude_code_credentials` WHERE `is_default` = 1 GROUP BY `type`
);--> statement-breakpoint
DROP INDEX IF EXISTS `ccc_user_scope_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `ccc_user_default_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `ccc_user_source_idx`;--> statement-breakpoint
ALTER TABLE `claude_code_credentials` DROP COLUMN `user_id`;--> statement-breakpoint
ALTER TABLE `claude_code_credentials` DROP COLUMN `cloud_account_id`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ccc_type_label_idx` ON `claude_code_credentials` (`type`, `account_label`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ccc_default_idx` ON `claude_code_credentials` (`is_default`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ccc_source_idx` ON `claude_code_credentials` (`source`);--> statement-breakpoint

-- ============ tables that go entirely ============
-- The Neon account-sync retry queue and a local integrations table that never had a reader.
DROP TABLE IF EXISTS `pending_account_syncs`;--> statement-breakpoint
DROP TABLE IF EXISTS `user_integrations`;--> statement-breakpoint

-- ============ flows ============
DROP INDEX IF EXISTS `flows_user_idx`;--> statement-breakpoint
ALTER TABLE `flows` DROP COLUMN `user_id`;--> statement-breakpoint

-- ============ flow_runs ============
DROP INDEX IF EXISTS `flow_runs_user_status_idx`;--> statement-breakpoint
ALTER TABLE `flow_runs` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_runs_status_idx` ON `flow_runs` (`status`);--> statement-breakpoint

-- ============ flow_kv_state ============
DELETE FROM `flow_kv_state` WHERE `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `flow_kv_state` GROUP BY `flow_id`, `key`
);--> statement-breakpoint
DROP INDEX IF EXISTS `flow_kv_state_uniq`;--> statement-breakpoint
DROP INDEX IF EXISTS `flow_kv_state_lookup_idx`;--> statement-breakpoint
ALTER TABLE `flow_kv_state` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_kv_state_uniq` ON `flow_kv_state` (`flow_id`, `key`);--> statement-breakpoint

-- ============ briefing_stashes ============
DROP INDEX IF EXISTS `briefing_stashes_user_idx`;--> statement-breakpoint
ALTER TABLE `briefing_stashes` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `briefing_stashes_created_idx` ON `briefing_stashes` (`created_at`);--> statement-breakpoint

-- ============ batch_plan_templates ============
DELETE FROM `batch_plan_templates` WHERE `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `batch_plan_templates` GROUP BY lower(`name`)
);--> statement-breakpoint
DROP INDEX IF EXISTS `batch_plan_templates_user_name_uniq`;--> statement-breakpoint
DROP INDEX IF EXISTS `batch_plan_templates_user_idx`;--> statement-breakpoint
ALTER TABLE `batch_plan_templates` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `batch_plan_templates_name_uniq` ON `batch_plan_templates` (lower(`name`));--> statement-breakpoint

-- ============ tasks ============
-- The idempotency key is the inbound webhook dedup key, so the first delivery of a source/source_id
-- is the one that wins and the later duplicates go.
DELETE FROM `tasks` WHERE `source_id` IS NOT NULL AND `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `tasks` WHERE `source_id` IS NOT NULL GROUP BY `source`, `source_id`
);--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_user_status_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_user_executed_by_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_idempotency_uniq`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_status_created_idx` ON `tasks` (`status`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_executed_by_idx` ON `tasks` (`executed_by`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_idempotency_uniq` ON `tasks` (`source`, `source_id`)
	WHERE `source_id` IS NOT NULL;--> statement-breakpoint

-- ============ flow_trigger_bindings ============
-- Losing rows are deactivated rather than deleted: the unique key covers active rows only, and a
-- disabled binding still carries the configuration the owner wrote.
UPDATE `flow_trigger_bindings` SET `is_active` = 0 WHERE `is_active` = 1 AND `rowid` NOT IN (
	SELECT MIN(`rowid`) FROM `flow_trigger_bindings` WHERE `is_active` = 1
	GROUP BY `flow_id`, COALESCE(`project_id`, ''), `trigger_type`
);--> statement-breakpoint
DROP INDEX IF EXISTS `flow_trigger_bindings_user_active_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `flow_trigger_bindings_uq`;--> statement-breakpoint
ALTER TABLE `flow_trigger_bindings` DROP COLUMN `user_id`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `flow_trigger_bindings_active_idx` ON `flow_trigger_bindings` (`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `flow_trigger_bindings_uq` ON `flow_trigger_bindings` (
	`flow_id`, COALESCE(`project_id`, ''), `trigger_type`
) WHERE `is_active` = 1;--> statement-breakpoint

-- ============ plugin installations and their connection lifecycles ============
-- A lost lifecycle row reads as an unmanaged connection and lets a paused plugin execute, so a
-- duplicate connection or an orphaned plugin aborts this migration before anything is written.
CREATE TABLE `__plugin_lifecycle_precheck` (`n` integer NOT NULL CHECK (`n` = 0));--> statement-breakpoint
INSERT INTO `__plugin_lifecycle_precheck` (`n`) SELECT count(*) FROM (
	SELECT `connection_id` FROM `plugin_connection_lifecycles` GROUP BY `connection_id` HAVING count(*) > 1
);--> statement-breakpoint
INSERT INTO `__plugin_lifecycle_precheck` (`n`) SELECT count(*) FROM `plugin_connection_lifecycles` `l`
	WHERE NOT EXISTS (SELECT 1 FROM `plugin_installations` `p` WHERE `p`.`plugin_id` = `l`.`plugin_id`);--> statement-breakpoint
DROP TABLE `__plugin_lifecycle_precheck`;--> statement-breakpoint
-- Point every lifecycle row at the installation that survives, so collapsing the duplicates below
-- cannot break the composite key the old child still references.
UPDATE `plugin_connection_lifecycles` SET `user_id` = (
	SELECT `q`.`user_id` FROM `plugin_installations` `q`
	WHERE `q`.`plugin_id` = `plugin_connection_lifecycles`.`plugin_id`
	ORDER BY `q`.`is_installed` DESC, `q`.`rowid` LIMIT 1
);--> statement-breakpoint
DELETE FROM `plugin_installations` WHERE `rowid` NOT IN (
	SELECT (
		SELECT `q`.`rowid` FROM `plugin_installations` `q` WHERE `q`.`plugin_id` = `p`.`plugin_id`
		ORDER BY `q`.`is_installed` DESC, `q`.`rowid` LIMIT 1
	) FROM `plugin_installations` `p` GROUP BY `p`.`plugin_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `plugin_installations_plugin_uq` ON `plugin_installations` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_connection_lifecycles_new` (
	`plugin_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`provisioning_state` text DEFAULT 'pending' NOT NULL,
	`cleanup_state` text DEFAULT 'idle' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `plugin_connection_lifecycles_connection_pk` PRIMARY KEY (`connection_id`),
	CONSTRAINT `plugin_connection_lifecycles_installation_fk` FOREIGN KEY (`plugin_id`)
		REFERENCES `plugin_installations`(`plugin_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `plugin_connection_lifecycles_lifecycle_check`
		CHECK (`lifecycle_state` IN ('active', 'disabled', 'disconnecting', 'disconnected')),
	CONSTRAINT `plugin_connection_lifecycles_provisioning_check`
		CHECK (`provisioning_state` IN ('pending', 'ready', 'user_managed', 'failed')),
	CONSTRAINT `plugin_connection_lifecycles_cleanup_check`
		CHECK (`cleanup_state` IN ('idle', 'pending', 'failed', 'complete')),
	CONSTRAINT `plugin_connection_lifecycles_error_code_check`
		CHECK (`error_code` IS NULL OR `error_code` IN ('configuration_invalid', 'credential_binding_unavailable', 'mcp_provision_failed', 'upstream_revoke_failed', 'managed_mcp_cleanup_failed', 'webhook_cleanup_failed', 'local_cleanup_failed', 'unknown_lifecycle_failure'))
);--> statement-breakpoint
INSERT INTO `plugin_connection_lifecycles_new` (
	`plugin_id`, `connection_id`, `lifecycle_state`, `provisioning_state`, `cleanup_state`, `error_code`, `created_at`, `updated_at`
) SELECT `plugin_id`, `connection_id`, `lifecycle_state`, `provisioning_state`, `cleanup_state`, `error_code`, `created_at`, `updated_at`
	FROM `plugin_connection_lifecycles`;--> statement-breakpoint
CREATE TABLE `__plugin_lifecycle_parity` (`n` integer NOT NULL CHECK (`n` = 0));--> statement-breakpoint
INSERT INTO `__plugin_lifecycle_parity` (`n`)
	SELECT (SELECT count(*) FROM `plugin_connection_lifecycles_new`) - (SELECT count(*) FROM `plugin_connection_lifecycles`);--> statement-breakpoint
DROP TABLE `__plugin_lifecycle_parity`;--> statement-breakpoint
DROP TABLE `plugin_connection_lifecycles`;--> statement-breakpoint
ALTER TABLE `plugin_connection_lifecycles_new` RENAME TO `plugin_connection_lifecycles`;--> statement-breakpoint
DROP INDEX IF EXISTS `plugin_installations_user_plugin_uq`;--> statement-breakpoint
DROP INDEX IF EXISTS `plugin_installations_user_lifecycle_idx`;--> statement-breakpoint
ALTER TABLE `plugin_installations` DROP COLUMN `user_id`;
