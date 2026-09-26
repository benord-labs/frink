-- Admit 'gmail' to the Nango handoff tables (gmail joins the installable Nango plugin set). SQLite cannot alter a CHECK
-- constraint, so each table is rebuilt in place; both hold short-lived in-flight
-- OAuth state, and the copy keeps any handoff that is mid-flight across upgrade.

CREATE TABLE `pending_nango_handoffs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`connection_hash` text NOT NULL,
	`connection_id_encrypted` text NOT NULL,
	`integration_id` text,
	`reconnect_integration_id` text,
	`reconnect_expected_connection_hash` text,
	`reconnect_expected_connection_id_encrypted` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `pending_nango_handoffs_provider_check`
		CHECK (`provider_id` IN ('slack', 'clickup', 'linear', 'gmail')),
	CONSTRAINT `pending_nango_handoffs_hash_check`
		CHECK (length(`connection_hash`) = 64),
	CONSTRAINT `pending_nango_handoffs_ciphertext_check`
		CHECK (length(`connection_id_encrypted`) > 0),
	CONSTRAINT `pending_nango_handoffs_reconnect_context_check`
		CHECK (
			(
				`reconnect_integration_id` IS NULL
				AND `reconnect_expected_connection_hash` IS NULL
				AND `reconnect_expected_connection_id_encrypted` IS NULL
			) OR (
				`reconnect_integration_id` IS NOT NULL
				AND `reconnect_expected_connection_hash` IS NOT NULL
				AND `reconnect_expected_connection_id_encrypted` IS NOT NULL
				AND length(`reconnect_integration_id`) > 0
				AND length(`reconnect_expected_connection_hash`) = 64
				AND length(`reconnect_expected_connection_id_encrypted`) > 0
			)
		)
);
--> statement-breakpoint
INSERT INTO `pending_nango_handoffs_new`
SELECT
	`id`, `user_id`, `provider_id`, `connection_hash`, `connection_id_encrypted`,
	`integration_id`, `reconnect_integration_id`, `reconnect_expected_connection_hash`,
	`reconnect_expected_connection_id_encrypted`, `created_at`, `updated_at`
FROM `pending_nango_handoffs`;
--> statement-breakpoint
DROP TABLE `pending_nango_handoffs`;
--> statement-breakpoint
ALTER TABLE `pending_nango_handoffs_new` RENAME TO `pending_nango_handoffs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_nango_handoffs_user_provider_hash_uq` ON `pending_nango_handoffs` (`user_id`,`provider_id`,`connection_hash`);
--> statement-breakpoint
CREATE INDEX `pending_nango_handoffs_user_updated_idx` ON `pending_nango_handoffs` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `pending_nango_reconnect_intents_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`finalization_token_hash` text NOT NULL,
	`expected_connection_hash` text NOT NULL,
	`expected_connection_id_encrypted` text NOT NULL,
	`finalized_connection_hash` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `pending_nango_reconnect_intents_provider_check`
		CHECK (`provider_id` IN ('slack', 'clickup', 'linear', 'gmail')),
	CONSTRAINT `pending_nango_reconnect_intents_hashes_check`
		CHECK (
			length(`finalization_token_hash`) = 64
			AND length(`expected_connection_hash`) = 64
			AND (`finalized_connection_hash` IS NULL OR length(`finalized_connection_hash`) = 64)
		),
	CONSTRAINT `pending_nango_reconnect_intents_ciphertext_check`
		CHECK (length(`expected_connection_id_encrypted`) > 0)
);
--> statement-breakpoint
INSERT INTO `pending_nango_reconnect_intents_new`
SELECT
	`id`, `user_id`, `integration_id`, `provider_id`, `finalization_token_hash`,
	`expected_connection_hash`, `expected_connection_id_encrypted`,
	`finalized_connection_hash`, `expires_at`, `created_at`, `updated_at`
FROM `pending_nango_reconnect_intents`;
--> statement-breakpoint
DROP TABLE `pending_nango_reconnect_intents`;
--> statement-breakpoint
ALTER TABLE `pending_nango_reconnect_intents_new` RENAME TO `pending_nango_reconnect_intents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_nango_reconnect_intents_user_integration_uq`
	ON `pending_nango_reconnect_intents` (`user_id`, `integration_id`);
--> statement-breakpoint
CREATE INDEX `pending_nango_reconnect_intents_user_expires_idx`
	ON `pending_nango_reconnect_intents` (`user_id`, `expires_at`);
