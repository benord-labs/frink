CREATE TABLE `node_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`node_name` text NOT NULL,
	`credential_key` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `nc_node_key_idx` ON `node_credentials` (`node_name`,`credential_key`);
