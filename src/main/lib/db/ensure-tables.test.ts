import { describe, expect, it, vi } from 'vitest';
import { ensureChatLinkedProjectsTable } from './index';
import type { NodeSqliteDatabase } from './node-sqlite-driver';
import { freshDb } from './test-utils/fresh-db';

vi.mock('electron', () => ({ app: {} }));

/** Columns, keys, and indexes with their columns, so the safety net cannot drift from 0116. */
function shape(sqlite: NodeSqliteDatabase) {
  const pragma = (name: string, of = 'chat_linked_projects') =>
    sqlite.prepare(`PRAGMA ${name}(${of})`).all() as Array<{ name: string }>;
  const indexes = pragma('index_list');
  const indexColumns = indexes.map((index) => pragma('index_info', index.name));
  return [pragma('table_info'), pragma('foreign_key_list'), indexes, indexColumns];
}

describe('ensureChatLinkedProjectsTable', () => {
  it('recreates the migrated table when it is missing, and is safe to run twice', () => {
    const sqlite = freshDb().$client;
    const migrated = shape(sqlite);
    sqlite.exec('DROP TABLE chat_linked_projects');

    ensureChatLinkedProjectsTable(sqlite);
    ensureChatLinkedProjectsTable(sqlite);

    expect(shape(sqlite)).toEqual(migrated);
    expect(migrated[2]).toHaveLength(2);
  });
});
