-- Phase 1.5 follow-up: indexes for the local-first chat read paths.
--
-- Without these, every sidebar load (`listChatsForProject`, `countChatsByProject`,
-- `listArchivedChats`, `pageChatsForProjects`), every stats query
-- (`getFileStats`, `getPendingPlanApprovals`), and every archive/delete worktree
-- check (`hasOtherActiveChatsSharingWorktree`) does a full table scan against
-- `chats` and `sub_chats`. Fine on a fresh install; gets noticeable past a few
-- thousand chats — and triggers / flow runs can produce many.
--
-- chats: composite (project_id, archived_at) covers the most common predicate
-- combo: "non-archived chats for this project". archived_at as the second key
-- still permits `WHERE project_id = ?` lookups.
--
-- sub_chats.chat_id: every `listSubChatsByChat`, `getChatStats`, `forkChatWithSubChats`
-- filters on this; bulk delete of a chat (cascade) also benefits.
--
-- Hand-written migration (consistent with the post-0005 pattern in this folder —
-- the snapshot chain is out of sync, regen would diff against an 11-migrations
-- stale snapshot. See docs/local-first-migration.md and the 0064 migration's
-- accompanying notes).

CREATE INDEX IF NOT EXISTS `chats_project_archived_idx` ON `chats` (`project_id`, `archived_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sub_chats_chat_id_idx` ON `sub_chats` (`chat_id`);
