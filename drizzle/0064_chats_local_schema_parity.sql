-- Local-first migration Phase 1: schema parity for chats + backfill progress tracking.
--
-- Adds columns to the local `chats` table that the cloud has carried but local SQLite did not:
--   - `mode`       — default sub-chat mode for new sub-chats in this chat ('plan' | 'agent')
--   - `pinned_at`  — pinned chats float to the top of the sidebar (NULL = not pinned)
--
-- Creates a small `_backfill_progress` table used by the one-shot Neon→SQLite chats backfill
-- (see src/main/lib/db/backfill/chats-from-cloud.ts). The backfill flips PRAGMA user_version=2
-- only after every cloud chat has a row here, so partial completions resume on the next launch.
--
-- Hand-written migration (consistent with the post-0005 pattern in this folder — see the snapshot
-- gap discussion in docs/plans/2026-04-29-local-first-phase-1-chats-sqlite.md).
--
-- Notes:
--   - sub_chats.additions / deletions / file_count are NOT added here — migration 0005 already added
--     them with DEFAULT 0 (without NOT NULL). The TypeScript schema mirrors that nullability.
--   - chats.user_id intentionally omitted; local SQLite is single-user.

ALTER TABLE `chats` ADD `mode` text DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE `chats` ADD `pinned_at` integer;--> statement-breakpoint
CREATE TABLE `_backfill_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`completed_at` integer NOT NULL
);
