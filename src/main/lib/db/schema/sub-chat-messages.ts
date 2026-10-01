import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

type SubChatsTable = typeof import('./index').subChats;

/** One row per transcript message: `seq` is its index in the transcript, `message` its whole JSON. */
export function defineSubChatMessages(subChats: SubChatsTable) {
  return sqliteTable(
    'sub_chat_messages',
    {
      subChatId: text('sub_chat_id')
        .notNull()
        .references(() => subChats.id, { onDelete: 'cascade' }),
      seq: integer('seq').notNull(),
      message: text('message').notNull(),
    },
    (table) => [primaryKey({ columns: [table.subChatId, table.seq] })],
  );
}
