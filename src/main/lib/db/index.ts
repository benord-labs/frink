import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { app } from 'electron';
import { collectNormalizedUpdates } from '../../../shared/lib/git-url';
import { runCredentialMigrationSweep } from '../credentials/migration-sweep';
import { ensureDirExists } from '../fs-helpers';
import { drizzleNodeSqlite } from './drizzle-node-sqlite';
import { NodeSqliteDatabase } from './node-sqlite-driver';
import { normalizeToolPartStates } from './normalize-tool-part-states';
import * as schema from './schema';

let db: BetterSQLite3Database<typeof schema> | null = null;
let sqlite: NodeSqliteDatabase | null = null;

/**
 * Get the database path in the app's user data directory
 */
export function getDatabasePath(): string {
  const userDataPath = app.getPath('userData');
  const dataDir = join(userDataPath, 'data');

  ensureDirExists(dataDir);

  return join(dataDir, 'agents.db');
}

/**
 * Get the migrations folder path
 * Handles both development and production (packaged) environments
 */
function getMigrationsPath(): string {
  if (app.isPackaged) {
    // Production: migrations bundled in resources
    return join(process.resourcesPath, 'migrations');
  }
  // Development: try app path first, fall back to cwd (handles worktree dev)
  const appDrizzle = join(app.getAppPath(), 'drizzle');
  if (existsSync(join(appDrizzle, 'meta', '_journal.json'))) {
    return appDrizzle;
  }
  return join(process.cwd(), 'drizzle');
}

/**
 * Initialize the database with Drizzle ORM
 */
export function initDatabase() {
  if (db) {
    return db;
  }

  // Test isolation: this opens the user's REAL agents.db. Tests must use freshDb()
  // (in-memory) or vi.mock this module — a leaked call here can corrupt real data.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    throw new Error(
      'initDatabase opens the real agents.db — tests must use freshDb() or vi.mock the db module',
    );
  }

  const dbPath = getDatabasePath();
  const migrationsPath = getMigrationsPath();

  // Create SQLite connection
  sqlite = new NodeSqliteDatabase(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // The FULL default fsyncs the WAL on EVERY commit, on the loop that drains the agent's stdout —
  // host load became visibly stuttering output. NORMAL still survives an app/process crash; see
  // docs/decisions/local-sqlite-durability.md.
  sqlite.pragma('synchronous = NORMAL');

  // Create Drizzle instance (the driver is API-compatible with better-sqlite3's surface Drizzle uses)
  db = drizzleNodeSqlite(sqlite, schema);

  try {
    // Run migrations
    migrate(db, { migrationsFolder: migrationsPath });

    // Defensive: ensure claude_code_credentials has a "type" column
    // Handles DBs created before 0022_add_ai_account_type or when migrations path was wrong
    ensureClaudeCodeCredentialsTypeColumn(sqlite);

    // Defensive: ensure credential-source columns exist (migration 0063_credential_source).
    // Adds source, source_path, expected_email, last_resolved_from_source_at, needs_reauth_at.
    ensureCredentialSourceColumns(sqlite);

    // Defensive: ensure chats has task_id column (migration 0007 was a no-op while chats
    // were on Neon; 0006 recreates the table with task_id, but installs that ran 0007 as a
    // no-op without rebuilding via 0006 are missing the column. Affects task-executor
    // createChat and any other path that writes taskId.)
    ensureChatsTaskIdColumn(sqlite);

    // Defensive: ensure project_ai_accounts and the projects.description column exist
    // (migration 0066, project localization milestone).
    // Same back-dated `when` skip risk that hit 0006/0007.
    ensureProjectsDescriptionColumn(sqlite);
    ensureProjectAccountRoutingTables(sqlite);

    // One-shot sweep: classify legacy OAuth-snapshot rows vs API-key rows.
    // Idempotent (guarded by user_version). Aborts safely on no-keyring / decrypt errors.
    runCredentialMigrationSweep(sqlite);

    // Normalize existing git_remote_url values to canonical form (SSH alias support)
    normalizeExistingGitRemoteUrls(sqlite);

    // Must run last — see normalizeToolPartStates' own doc for why order matters here.
    normalizeToolPartStates(sqlite);

    // Phase 1 local-first migration: chats start fresh in local SQLite. The Neon →
    // SQLite backfill that briefly lived here was deleted (Path B) — local rows are
    // populated on the fly by the chat routers, and historical Neon chat data is
    // intentionally NOT migrated.
  } catch (error) {
    // Avoid returning a poisoned singleton when migration/init fails.
    try {
      sqlite.close();
    } catch {
      // Ignore close errors during cleanup.
    }
    sqlite = null;
    db = null;
    throw error;
  }

  return db;
}

/**
 * Add type column to claude_code_credentials if missing (SQLite has no ADD COLUMN IF NOT EXISTS).
 */
function ensureClaudeCodeCredentialsTypeColumn(dbInstance: NodeSqliteDatabase): void {
  const rows = dbInstance.prepare('PRAGMA table_info(claude_code_credentials)').all() as {
    name: string;
  }[];
  const hasType = rows.some((r) => r.name === 'type');
  if (!hasType) {
    dbInstance.exec(
      "ALTER TABLE claude_code_credentials ADD COLUMN type TEXT NOT NULL DEFAULT 'claude-code'",
    );
  }
}

/**
 * Ensure chats has task_id column.
 *
 * Migration 0007_add_task_id_to_chats.sql was a no-op (chats were on Neon at the time).
 * Migration 0006_nullable_project_id.sql recreates the chats table with task_id, so fresh
 * installs after 0006 ran cleanly carry the column. Installs that ran 0007 as a no-op
 * without ever rebuilding via 0006 (or where 0006 was skipped due to journal timestamp
 * ordering) are missing the column. Phase 1 chat localization brought writes back to
 * local SQLite, surfacing the gap as `table chats has no column named task_id` errors
 * from task-executor createChat and the chat creation router.
 *
 * Idempotent: PRAGMA table_info is cheap; ALTER TABLE only fires when the column is missing.
 */
function ensureChatsTaskIdColumn(dbInstance: NodeSqliteDatabase): void {
  const tables = dbInstance
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'")
    .all() as { name: string }[];
  if (tables.length === 0) return;

  const cols = dbInstance.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
  if (!cols.some((r) => r.name === 'task_id')) {
    dbInstance.exec('ALTER TABLE chats ADD COLUMN task_id TEXT');
  }
}

/**
 * Ensure projects has the description column added by migration 0066. Same skip-risk
 * pattern as ensureChatsTaskIdColumn — back-dated migration timestamps can be silently
 * passed over by Drizzle's better-sqlite3 migrator.
 */
function ensureProjectsDescriptionColumn(dbInstance: NodeSqliteDatabase): void {
  const tables = dbInstance
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
    .all() as { name: string }[];
  if (tables.length === 0) return;

  const cols = dbInstance.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
  if (!cols.some((r) => r.name === 'description')) {
    dbInstance.exec('ALTER TABLE projects ADD COLUMN description TEXT');
  }
}

/**
 * project_ai_accounts was re-keyed from account_label to account_id by 0078. CREATE TABLE
 * IF NOT EXISTS cannot repair a column rename, so an old-shape table is dropped first —
 * safe because 0078 discards those rows anyway (a label cannot be mapped to a single
 * account id, which is the defect it fixes).
 */
function ensureProjectAccountRoutingTables(dbInstance: NodeSqliteDatabase): void {
  // Skip if projects table doesn't exist yet (e.g. fresh install before migrate ran).
  const projectsExists = dbInstance
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
    .all() as { name: string }[];
  if (projectsExists.length === 0) return;

  const aiCols = dbInstance.prepare('PRAGMA table_info(project_ai_accounts)').all() as {
    name: string;
  }[];
  if (aiCols.length > 0 && !aiCols.some((c) => c.name === 'account_id')) {
    dbInstance.exec('DROP TABLE project_ai_accounts');
  }

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS project_ai_accounts (
      project_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (account_id) REFERENCES claude_code_credentials(id) ON UPDATE no action ON DELETE cascade
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_ai_accounts_project_idx
      ON project_ai_accounts (project_id);
  `);
}

/**
 * Ensure credential-source columns exist on claude_code_credentials.
 *
 * Mirrors migration 0063_credential_source. Drizzle's better-sqlite3 migrator may
 * skip this migration on dev DBs whose last-applied `when` timestamp postdates it,
 * so we apply the same ALTER ADD statements defensively at startup.
 */
function ensureCredentialSourceColumns(dbInstance: NodeSqliteDatabase): void {
  const cols = dbInstance.prepare('PRAGMA table_info(claude_code_credentials)').all() as {
    name: string;
  }[];
  const have = new Set(cols.map((r) => r.name));

  if (!have.has('source')) {
    dbInstance.exec(
      "ALTER TABLE claude_code_credentials ADD COLUMN source TEXT NOT NULL DEFAULT 'api-key'",
    );
  }
  if (!have.has('source_path')) {
    dbInstance.exec('ALTER TABLE claude_code_credentials ADD COLUMN source_path TEXT');
  }
  if (!have.has('expected_email')) {
    dbInstance.exec('ALTER TABLE claude_code_credentials ADD COLUMN expected_email TEXT');
  }
  if (!have.has('last_resolved_from_source_at')) {
    dbInstance.exec(
      'ALTER TABLE claude_code_credentials ADD COLUMN last_resolved_from_source_at INTEGER',
    );
  }
  if (!have.has('needs_reauth_at')) {
    dbInstance.exec('ALTER TABLE claude_code_credentials ADD COLUMN needs_reauth_at INTEGER');
  }

  dbInstance.exec('CREATE INDEX IF NOT EXISTS ccc_source_idx ON claude_code_credentials (source)');
}

/**
 * Normalize existing git_remote_url values in local SQLite to canonical form.
 * Handles SSH host aliases (e.g. github.com-work -> github.com/owner/repo).
 *
 * Uses `PRAGMA user_version` to skip the full-table scan on subsequent launches.
 * user_version tracks one-shot data-normalization migrations (not schema — that's Drizzle).
 * Bump the target version and add a new block when adding future normalizations.
 *   1 = git_remote_url canonical normalization
 *   2 = credential OAuth-snapshot vs API-key sweep (credentials/migration-sweep.ts)
 *   3 = tool-part state vocabulary (normalize-tool-part-states.ts)
 */
function normalizeExistingGitRemoteUrls(dbInstance: NodeSqliteDatabase): void {
  // user_version >= 1 means normalization already ran — skip
  const currentVersion = (dbInstance.pragma('user_version', { simple: true }) as number) ?? 0;
  if (currentVersion >= 1) return;

  const rows = dbInstance
    .prepare('SELECT id, git_remote_url FROM projects WHERE git_remote_url IS NOT NULL')
    .all() as {
    id: string;
    git_remote_url: string;
  }[];

  const updates = collectNormalizedUpdates(
    rows,
    (r) => r.id,
    (r) => r.git_remote_url,
  );

  const updateStmt = dbInstance.prepare('UPDATE projects SET git_remote_url = ? WHERE id = ?');
  for (const u of updates) {
    updateStmt.run(u.normalized, u.id);
  }

  // Mark normalization complete
  dbInstance.pragma('user_version = 1');
}

/**
 * Get the database instance
 */
export function getDatabase() {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
    db = null;
  }
}

// Re-export schema for convenience
export * from './schema';
