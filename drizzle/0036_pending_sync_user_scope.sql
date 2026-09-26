-- NOTE: Intentionally rebuilt (drop + recreate) because this is a retry queue, not source-of-truth data.
-- We enforce strict non-legacy semantics here: pending rows are disposable and must include user_id NOT NULL.
DROP TABLE IF EXISTS `pending_account_syncs`;
--> statement-breakpoint
CREATE TABLE `pending_account_syncs` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `operation` TEXT NOT NULL,
  `account_label` TEXT NOT NULL,
  `account_type` TEXT,
  `old_label` TEXT,
  `local_account_id` TEXT,
  `cloud_account_id` TEXT,
  `user_id` TEXT NOT NULL,
  `created_at` INTEGER DEFAULT (unixepoch()),
  `retry_count` INTEGER DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pas_user_operation_idx` ON `pending_account_syncs` (`user_id`,`operation`,`created_at`);
