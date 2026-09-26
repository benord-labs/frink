-- Persist only hashes plus the safeStorage ciphertext required to bind the
-- latest reconnect session across an Electron main-process restart.

CREATE TABLE `pending_nango_reconnect_intents` (
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
    CHECK (`provider_id` IN ('slack', 'clickup')),
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
CREATE UNIQUE INDEX `pending_nango_reconnect_intents_user_integration_uq`
  ON `pending_nango_reconnect_intents` (`user_id`, `integration_id`);
--> statement-breakpoint
CREATE INDEX `pending_nango_reconnect_intents_user_expires_idx`
  ON `pending_nango_reconnect_intents` (`user_id`, `expires_at`);
