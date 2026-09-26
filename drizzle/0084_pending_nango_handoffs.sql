-- Machine-local handoff for a completed Nango OAuth callback before the
-- trusted server has acknowledged either finalization or durable revocation.
-- Raw connection handles are encrypted with Electron safeStorage before insert.

CREATE TABLE IF NOT EXISTS `pending_nango_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`connection_hash` text NOT NULL,
	`connection_id_encrypted` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`provider_id` IN ('slack', 'clickup')),
	CHECK (length(`connection_hash`) = 64),
	CHECK (length(`connection_id_encrypted`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pending_nango_handoffs_user_provider_hash_uq` ON `pending_nango_handoffs` (`user_id`,`provider_id`,`connection_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pending_nango_handoffs_user_updated_idx` ON `pending_nango_handoffs` (`user_id`,`updated_at`);
