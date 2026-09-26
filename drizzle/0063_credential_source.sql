-- Add LOCAL-only credential-source columns to claude_code_credentials.
-- Distinguishes 'api-key' rows (encrypted token in oauth_token, multi, cloud-synced)
-- from 'claude-passthrough' rows (oauth_token NULL, token resolved live from
-- the keychain via source_path at chat-time, ONE per machine, NEVER cloud-synced).
--
-- Pure ALTER ADD — no decryption, no data manipulation. The credential-shape
-- classification + cleanup of legacy OAuth-snapshot rows runs as a separate
-- TS startup sweep (src/main/lib/credentials/migration-sweep.ts) AFTER Drizzle
-- migrations complete, gated on safeStorage.isEncryptionAvailable().

ALTER TABLE `claude_code_credentials` ADD COLUMN `source` text NOT NULL DEFAULT 'api-key';--> statement-breakpoint
ALTER TABLE `claude_code_credentials` ADD COLUMN `source_path` text;--> statement-breakpoint
ALTER TABLE `claude_code_credentials` ADD COLUMN `expected_email` text;--> statement-breakpoint
ALTER TABLE `claude_code_credentials` ADD COLUMN `last_resolved_from_source_at` integer;--> statement-breakpoint
ALTER TABLE `claude_code_credentials` ADD COLUMN `needs_reauth_at` integer;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `ccc_user_source_idx` ON `claude_code_credentials` (`user_id`,`source`);
