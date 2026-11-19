import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

type ChatsTable = typeof import('./index').chats;
type ProjectsTable = typeof import('./index').projects;

/** One row per project linked to a chat (migration 0116). Both keys cascade, so deleting either
 * side removes the link; rowid order is link order. Written only through repos/chat-linked-projects. */
export function defineChatLinkedProjects(chats: ChatsTable, projects: ProjectsTable) {
  return sqliteTable(
    'chat_linked_projects',
    {
      chatId: text('chat_id')
        .notNull()
        .references(() => chats.id, { onDelete: 'cascade' }),
      projectId: text('project_id')
        .notNull()
        .references(() => projects.id, { onDelete: 'cascade' }),
      createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
    },
    (table) => [
      uniqueIndex('chat_linked_projects_chat_project_idx').on(table.chatId, table.projectId),
      index('chat_linked_projects_project_idx').on(table.projectId),
    ],
  );
}
