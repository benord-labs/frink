-- The project picker orders projects by `max(sub_chats.updated_at)` per chat. With only a
-- `chat_id` index, SQLite reads each sub_chat row to reach `updated_at`, which sits after the
-- large `messages` JSON column, so every picker load walked every transcript. The composite index
-- covers that aggregate and still serves every `WHERE chat_id = ?` lookup, so it replaces the old one.
CREATE INDEX IF NOT EXISTS `sub_chats_chat_id_updated_at_idx` ON `sub_chats` (`chat_id`, `updated_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `sub_chats_chat_id_idx`;
