import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// App-wide preferences main must read (migration 0105), e.g. the global Thinking switch the
// phone and every window share. `value` is JSON text; keys are namespaced (`composer.*`).
export const appPreferences = sqliteTable('app_preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
