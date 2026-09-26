-- Machine-local operational state for a plugin's immutable account connection.
-- This table deliberately stores no provider credentials or raw error messages.

CREATE TABLE IF NOT EXISTS `plugin_connection_lifecycles` (
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`provisioning_state` text DEFAULT 'pending' NOT NULL,
	`cleanup_state` text DEFAULT 'idle' NOT NULL,
	`error_code` text,
	`managed_mcp_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `connection_id`),
	FOREIGN KEY (`user_id`, `plugin_id`) REFERENCES `plugin_installations`(`user_id`, `plugin_id`),
	CHECK (`lifecycle_state` IN ('active', 'disabled', 'disconnecting', 'disconnected')),
	CHECK (`provisioning_state` IN ('pending', 'ready', 'user_managed', 'failed')),
	CHECK (`cleanup_state` IN ('idle', 'pending', 'failed', 'complete')),
	CHECK (`error_code` IS NULL OR `error_code` IN ('configuration_invalid', 'credential_binding_unavailable', 'mcp_provision_failed', 'upstream_revoke_failed', 'managed_mcp_cleanup_failed', 'webhook_cleanup_failed', 'local_cleanup_failed', 'unknown_lifecycle_failure'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `plugin_connection_lifecycles_user_plugin_idx` ON `plugin_connection_lifecycles` (`user_id`,`plugin_id`);
