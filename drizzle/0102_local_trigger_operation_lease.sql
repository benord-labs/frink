-- A short lease per endpoint row, so two app instances cannot interleave the vendor round trips
-- that register, rotate or remove one subscription. `api_token_encrypted` holds the key an
-- api_token registrar needs on this machine; it is safeStorage ciphertext, never a raw key.

ALTER TABLE `integrations` ADD `api_token_encrypted` text;
--> statement-breakpoint
ALTER TABLE `integration_webhooks` ADD `operation_id` text;
--> statement-breakpoint
ALTER TABLE `integration_webhooks` ADD `operation_expires_at` integer;
