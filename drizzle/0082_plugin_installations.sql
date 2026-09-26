-- Local plugin product lifecycle. Account/auth connections remain in
-- user_integrations and deliberately have no FK to this table.

CREATE TABLE IF NOT EXISTS `plugin_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_locator` text,
	`installed_version` text,
	`is_installed` integer DEFAULT 1 NOT NULL,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	`installed_at` integer NOT NULL,
	`uninstalled_at` integer,
	`updated_at` integer NOT NULL,
	CHECK (`source_kind` IN ('frink_builtin', 'agent_plugins_v1')),
	CHECK (`is_installed` IN (0, 1)),
	CHECK (`is_enabled` IN (0, 1)),
	CHECK (`is_installed` = 1 OR `is_enabled` = 0),
	CHECK (`source_kind` != 'frink_builtin' OR `source_locator` IS NULL),
	CHECK (`source_kind` != 'agent_plugins_v1' OR (`source_locator` IS NOT NULL AND length(trim(`source_locator`)) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `plugin_installations_user_plugin_uq` ON `plugin_installations` (`user_id`,`plugin_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_installations_user_lifecycle_idx` ON `plugin_installations` (`user_id`,`is_installed`,`is_enabled`);
