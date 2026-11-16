-- Projects linked to a chat: the agent may read inside them as well as in the chat's own folder.
--
-- A join table rather than a JSON column on chats (the worktree_history pattern): both foreign
-- keys cascade, so deleting a chat or a linked project removes its links with no sweep, and a
-- link to a project that no longer exists cannot be written at all. UNIQUE(chat_id, project_id)
-- lets a repeated link be an insert-or-ignore. The project_id index serves the cascade.
--
-- IF NOT EXISTS because ensureChatLinkedProjectsTable (db/index.ts) creates the same table on a
-- machine whose journal skipped this migration.
--
-- Hand-written migration — drizzle's snapshot chain is stale (see 0078). Running
-- `drizzle-kit generate` would diff against an out-of-date snapshot and emit destructive SQL.

CREATE TABLE IF NOT EXISTS `chat_linked_projects` (
	`chat_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `chat_linked_projects_chat_project_idx` ON `chat_linked_projects` (`chat_id`,`project_id`);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `chat_linked_projects_project_idx` ON `chat_linked_projects` (`project_id`);
