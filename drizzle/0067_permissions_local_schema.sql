-- Local-first migration Phase 1.5: schema parity for permissions.
--
-- Adds local SQLite tables that mirror parked Neon migrations:
--   - `project_permissions` ← _neon-parked/0012, 0015, 0031
--   - `bash_permissions`    ← _neon-parked/0013, 0015, 0016
--   - The `permission_requests` table from Neon is intentionally OMITTED — it has zero
--     production callers in `src/`. Phase 2 cleanup ticket: remove from Neon + socket-server.
--
-- Hand-written. drizzle-kit's auto-generated output triggered table-rebuild noise from
-- the snapshot gap (post-0005 hand-edits). This file contains only the new-table SQL
-- plus the COALESCE-aware unique indexes that match Neon's behavior (`COALESCE` coerces
-- NULL to '' so the unique constraint actually applies — SQL standard NULL ≠ NULL would
-- otherwise leave duplicates).

CREATE TABLE IF NOT EXISTS `project_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`git_remote` text,
	`folder_id` text,
	`path` text NOT NULL,
	`is_relative` integer DEFAULT true,
	`operations` text DEFAULT '["read","write"]' NOT NULL,
	`duration` text DEFAULT 'always' NOT NULL,
	`expires_at` integer,
	`granted_at` integer,
	`use_count` integer DEFAULT 0,
	`last_used_at` integer,
	`status` text DEFAULT 'allowed' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pp_user_idx` ON `project_permissions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pp_user_git_remote_idx` ON `project_permissions` (`user_id`,`git_remote`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pp_user_folder_idx` ON `project_permissions` (`user_id`,`folder_id`);--> statement-breakpoint
-- COALESCE-aware unique index (decision #10): matches Neon's COALESCE(git_remote,'') and
-- COALESCE(folder_id::TEXT,'') semantics. Required because SQL NULL ≠ NULL otherwise.
CREATE UNIQUE INDEX IF NOT EXISTS `pp_unique_idx` ON `project_permissions` (
	`user_id`, COALESCE(`git_remote`, ''), COALESCE(`folder_id`, ''), `path`, `status`
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bash_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`git_remote` text,
	`folder_id` text,
	`command` text NOT NULL,
	`command_pattern` text,
	`duration` text DEFAULT 'always' NOT NULL,
	`expires_at` integer,
	`granted_at` integer,
	`use_count` integer DEFAULT 0,
	`last_used_at` integer,
	`status` text DEFAULT 'allowed' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bp_user_idx` ON `bash_permissions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bp_user_git_remote_idx` ON `bash_permissions` (`user_id`,`git_remote`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bp_user_folder_idx` ON `bash_permissions` (`user_id`,`folder_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bp_pattern_idx` ON `bash_permissions` (`command_pattern`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `bp_unique_idx` ON `bash_permissions` (
	`user_id`, COALESCE(`git_remote`, ''), COALESCE(`folder_id`, ''), `command`, `status`
);
