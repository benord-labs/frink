#!/usr/bin/env bun
/**
 * Seeds the QA profile's local sqlite with the deterministic fixture workspace
 * (see fixtures/). Run by scripts/qa/boot.sh after the profile wipe, before
 * the app launches.
 *
 * Runs under bun with bun:sqlite — the repo's better-sqlite3 binding is built
 * for Electron's ABI and would crash any plain node/bun script that loads it.
 * Applies the app's own drizzle migrations first, so the app boot that follows
 * finds a fully-migrated DB and skips straight past its migrator.
 *
 *   FRINK_HOME=<rig-home> bun scripts/qa/seed-db.ts --db <path-to-agents.db> --project-path <dir>
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../../src/main/lib/db/schema';
import {
  FIXTURE_CLAUDE_SOURCE_MARKER,
  FIXTURE_MCP_CONFIG,
  fixtureSourceUri,
  seedFixtures,
  verifyFixtures,
} from './fixtures';

function argValue(flag: string): string {
  const idx = process.argv.indexOf(flag);
  const value = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!value) {
    console.error(`seed-db: missing required ${flag} <value>`);
    process.exit(1);
  }
  return value;
}

const dbPath = resolve(argValue('--db'));
const projectPath = resolve(argValue('--project-path'));
const migrationsFolder = join(import.meta.dir, '../../drizzle');

// The seeded MCP config lands under FRINK_HOME — the same root boot.sh hands the app. Refuse the
// operator's real home outright: a QA run once rewrote the operator's MCP config (sc-2903).
const frinkHome = process.env.FRINK_HOME?.trim();
if (!frinkHome || realpathSync.native(frinkHome) === realpathSync.native(homedir())) {
  console.error(
    `seed-db: FRINK_HOME must name a rig-owned directory; "${frinkHome ?? ''}" is unset or resolves to the operator's real home.`,
  );
  process.exit(1);
}

mkdirSync(dirname(dbPath), { recursive: true });

// PostHog derives as connected from this registry entry (no credentials), so the plugin-node flow
// fixture's two steps exist on every boot; its schema row rides seedFixtures.
const mcpDir = join(frinkHome, '.frink', 'mcp');
mkdirSync(mcpDir, { recursive: true });
writeFileSync(join(mcpDir, 'config.json'), `${JSON.stringify(FIXTURE_MCP_CONFIG, null, 2)}\n`);

// The seeded Claude account resolves by finding this file, so it never depends on the operator's
// own Claude login. Empty on purpose: the probe checks presence only.
const claudeSourceMarker = join(resolve(frinkHome), FIXTURE_CLAUDE_SOURCE_MARKER);
writeFileSync(claudeSourceMarker, '');

const sqlite = new Database(dbPath);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
const db = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder });
// SAFETY: the drizzle types for the bun-sqlite and better-sqlite3 drivers share the sync
// BaseSQLiteDatabase surface fixtures/ is written against.
seedFixtures(
  db as Parameters<typeof seedFixtures>[0],
  projectPath,
  fixtureSourceUri(claudeSourceMarker),
);

const check = verifyFixtures(db as Parameters<typeof verifyFixtures>[0]);
if (!check.ok) {
  console.error(`seed-db: post-seed verification failed (${check.detail})`);
  process.exit(1);
}
sqlite.close();
console.log(`seed-db: fixture workspace ready (${check.detail}, project → ${projectPath})`);
