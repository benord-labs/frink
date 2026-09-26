import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzleNodeSqlite } from '../drizzle-node-sqlite';
import { NodeSqliteDatabase } from '../node-sqlite-driver';
import * as schema from '../schema';

export type TestDb = ReturnType<typeof drizzleNodeSqlite<typeof schema>>;

const DRIZZLE_DIR = join(__dirname, '../../../../../drizzle');

/**
 * In-memory sqlite + full migration chain. Use in repo and tRPC router tests
 * that need real schema behaviour without touching the user's app DB.
 */
export function freshDb(): TestDb {
  const sqlite = new NodeSqliteDatabase(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzleNodeSqlite(sqlite, schema);
  migrate(db, { migrationsFolder: DRIZZLE_DIR });
  return db;
}
