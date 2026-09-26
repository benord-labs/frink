-- Local inbound webhook endpoints. The machine verifies every delivery itself, so both secrets
-- are Electron safeStorage ciphertext; only the public path token is stored in the clear.

CREATE TABLE IF NOT EXISTS `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_user_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `integration_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`provider` text NOT NULL,
	`path_token` text NOT NULL,
	`subscribe_key_encrypted` text NOT NULL,
	`signing_secret_encrypted` text NOT NULL,
	`vendor_ref` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_received_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (length(`path_token`) = 64),
	CHECK (length(`subscribe_key_encrypted`) > 0),
	CHECK (length(`signing_secret_encrypted`) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `integration_webhooks_path_token_unique` ON `integration_webhooks` (`path_token`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `integration_webhooks_integration_active_idx` ON `integration_webhooks` (`integration_id`,`is_active`);
