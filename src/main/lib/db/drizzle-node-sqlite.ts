import type { Database as BetterSqlite3Client } from 'better-sqlite3';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session';
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { NodeSqliteDatabase } from './node-sqlite-driver';

/**
 * Drizzle wiring for the node:sqlite driver. Mirrors `construct()` from
 * drizzle-orm/better-sqlite3/driver, composed from public subpaths that do NOT
 * import the native module: the `drizzle-orm/better-sqlite3` entrypoint itself
 * `require`s better-sqlite3 unconditionally (driver.cjs:35) even when handed a
 * client, which would crash on a tree where the package no longer exists — the
 * session/sqlite-core/migrator subpaths are the verified-clean escape hatch.
 * (`BetterSQLite3Database` above is a type-only import: erased at compile time,
 * so the dirty entrypoint never loads at runtime.)
 */
export function drizzleNodeSqlite<TSchema extends Record<string, unknown>>(
  client: NodeSqliteDatabase,
  schema: TSchema,
): BetterSQLite3Database<TSchema> & { $client: NodeSqliteDatabase } {
  const dialect = new SQLiteSyncDialect({ casing: undefined });
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const schemaConfig = {
    fullSchema: schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  };
  const session = new BetterSQLiteSession(
    client as unknown as BetterSqlite3Client,
    dialect,
    schemaConfig as never,
    {},
  );
  const db = new BaseSQLiteDatabase(
    'sync',
    dialect,
    session as never,
    schemaConfig as never,
  ) as unknown as BetterSQLite3Database<TSchema> & { $client: NodeSqliteDatabase };
  db.$client = client;
  return db;
}
