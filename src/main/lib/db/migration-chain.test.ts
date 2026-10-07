import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFlowAdmissionIntentV1 } from '../../../shared/lib/flow-admission';
import { NodeSqliteDatabase } from './node-sqlite-driver';
import { freshDb } from './test-utils/fresh-db';

type JournalEntry = {
  idx: number;
  when: number;
  tag: string;
};

type PackageJson = {
  build?: {
    extraResources?: Array<{
      from?: string;
      filter?: string[];
    }>;
  };
};

const repoRoot = resolve(import.meta.dirname, '../../../../');
const drizzleDir = join(repoRoot, 'drizzle');
const journalPath = join(drizzleDir, 'meta', '_journal.json');
const packageJsonPath = join(repoRoot, 'package.json');
const MIGRATION_TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/;

function readJournalEntries(): JournalEntry[] {
  const journalRaw = readFileSync(journalPath, 'utf-8');
  const journal = JSON.parse(journalRaw) as { entries: JournalEntry[] };
  return journal.entries;
}

const NARROWED_TABLES = [
  'flows',
  'flow_runs',
  'flow_kv_state',
  'briefing_stashes',
  'batch_plan_templates',
  'tasks',
  'flow_trigger_bindings',
  'plugin_installations',
  'plugin_connection_lifecycles',
];

const NARROWED_INDEXES = [
  'ccc_type_label_idx',
  'flow_runs_status_idx',
  'flow_kv_state_uniq',
  'briefing_stashes_created_idx',
  'batch_plan_templates_name_uniq',
  'tasks_status_created_idx',
  'tasks_idempotency_uniq',
  'flow_trigger_bindings_uq',
  'plugin_installations_plugin_uq',
];

function columnNames(sqlite: NodeSqliteDatabase, table: string): string[] {
  // SAFETY: PRAGMA table_info projects its own fixed columns; `name` is TEXT.
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function tableNames(sqlite: NodeSqliteDatabase): string[] {
  // SAFETY: sqlite_master.name is TEXT and this query projects that single non-null column.
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(sqlite: NodeSqliteDatabase): string[] {
  // SAFETY: sqlite_master.name is TEXT and this query projects that single non-null column.
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function count(sqlite: NodeSqliteDatabase, fromClause: string): number {
  // SAFETY: callers pass literal table names from this file, never user input.
  const row = sqlite.prepare(`SELECT count(*) AS n FROM ${fromClause}`).get() as { n: number };
  return row.n;
}

/** Two accounts' rows in one database — the shape a real install reached before the drop. */
function seedTwoOwners(sqlite: NodeSqliteDatabase): void {
  sqlite.exec(`
    INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/tmp/p');
    INSERT INTO claude_code_credentials (id, type, account_label, user_id, is_default, source)
      VALUES ('cred-a', 'claude-code', 'Personal', 'user-a', 1, 'claude-passthrough'),
             ('cred-b', 'claude-code', 'Personal', 'user-b', 1, 'claude-passthrough');
    INSERT INTO project_ai_accounts (project_id, account_id) VALUES ('p1', 'cred-b');

    INSERT INTO flows (id, user_id, name) VALUES ('flow-a', 'user-a', 'A'), ('flow-b', 'user-b', 'B');
    INSERT INTO flow_versions (id, flow_id, version_number, graph)
      VALUES ('ver-a', 'flow-a', 1, '{}'), ('ver-b', 'flow-b', 1, '{}');
    INSERT INTO flow_runs (id, flow_version_id, user_id, status)
      VALUES ('run-a', 'ver-a', 'user-a', 'completed'), ('run-b', 'ver-b', 'user-b', 'completed');

    INSERT INTO flow_kv_state (id, user_id, flow_id, key, value)
      VALUES ('kv-a', 'user-a', 'flow-a', 'cursor', '{}'),
             ('kv-b', 'user-b', 'flow-a', 'cursor', '{}');
    INSERT INTO briefing_stashes (id, user_id, name, content, created_at)
      VALUES ('bs-a', 'user-a', 'A', 'a', 1), ('bs-b', 'user-b', 'B', 'b', 2);
    INSERT INTO batch_plan_templates (id, user_id, name, stages, created_at, updated_at)
      VALUES ('bt-a', 'user-a', 'Plan', '[]', 1, 1), ('bt-b', 'user-b', 'plan', '[]', 2, 2);

    INSERT INTO tasks (id, user_id, description, source, source_id, status, created_at)
      VALUES ('task-a', 'user-a', 'a', 'shortcut', 'sc-1', 'done', 1),
             ('task-b', 'user-b', 'b', 'shortcut', 'sc-1', 'done', 2);

    INSERT INTO flow_trigger_bindings (id, user_id, flow_id, trigger_type, is_active, created_at, updated_at)
      VALUES ('tb-a', 'user-a', 'flow-a', 'schedule_trigger', 1, 1, 1),
             ('tb-b', 'user-b', 'flow-a', 'schedule_trigger', 1, 2, 2);

    INSERT INTO plugin_installations (id, user_id, plugin_id, source_kind, installed_at, updated_at)
      VALUES ('pi-a', 'user-a', 'shortcut', 'frink_builtin', 1, 1),
             ('pi-b', 'user-b', 'shortcut', 'frink_builtin', 2, 2);
    INSERT INTO plugin_connection_lifecycles (user_id, plugin_id, connection_id, created_at, updated_at)
      VALUES ('user-a', 'shortcut', 'conn-a', 1, 1),
             ('user-b', 'shortcut', 'conn-b', 2, 2);
  `);
}

describe('database migration chain', () => {
  it('keeps sqlite migration journal strictly ordered and file-complete', () => {
    const entries = readJournalEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (let i = 0; i < entries.length; i += 1) {
      const current = entries[i];
      expect(current.idx).toBe(i);
      expect(current.tag).toMatch(MIGRATION_TAG_PATTERN);

      const migrationSqlPath = join(drizzleDir, `${current.tag}.sql`);
      expect(() => readFileSync(migrationSqlPath, 'utf-8')).not.toThrow();

      if (i > 0) {
        expect(current.when).toBeGreaterThan(entries[i - 1].when);
      }
    }
  });

  it('packages only sqlite journal migrations in extraResources', () => {
    const entries = readJournalEntries();
    const expectedSqlFiles = entries.map((entry) => `${entry.tag}.sql`).sort();

    const packageJsonRaw = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonRaw) as PackageJson;
    const drizzleResource = packageJson.build?.extraResources?.find(
      (resource) => resource.from === 'drizzle',
    );

    expect(drizzleResource).toBeDefined();
    expect(drizzleResource?.filter).toBeDefined();

    const filter = drizzleResource?.filter ?? [];
    expect(filter.includes('meta/**')).toBe(true);

    const filteredSqlFiles = filter.filter((entry) => entry.endsWith('.sql')).sort();
    const missingSqlFiles = expectedSqlFiles.filter((entry) => !filteredSqlFiles.includes(entry));
    const staleSqlFiles = filteredSqlFiles.filter((entry) => !expectedSqlFiles.includes(entry));

    expect(
      missingSqlFiles,
      `Missing sqlite migrations in package.json extraResources filter: ${missingSqlFiles.join(', ')}`,
    ).toHaveLength(0);
    expect(
      staleSqlFiles,
      `Stale sqlite migrations in package.json extraResources filter: ${staleSqlFiles.join(', ')}`,
    ).toHaveLength(0);
  });

  it('hard-prunes detached, legacy, and deleted-chat flow tasks', () => {
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE chats (id TEXT PRIMARY KEY);
        CREATE TABLE flow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          trigger_context TEXT,
          flow_run_id TEXT
        );
      `);
      sqlite.prepare('INSERT INTO chats (id) VALUES (?)').run('chat-live');
      sqlite.prepare('INSERT INTO flow_runs (id, status) VALUES (?, ?)').run('run-live', 'running');
      sqlite
        .prepare('INSERT INTO flow_runs (id, status) VALUES (?, ?)')
        .run('run-failed', 'failed');
      const insertTask = sqlite.prepare(
        'INSERT INTO tasks (id, source, status, result, flow_run_id) VALUES (?, ?, ?, ?, ?)',
      );
      insertTask.run(
        'delete-detached',
        'flow',
        'needs_attention',
        JSON.stringify({ chatId: 'chat-gone' }),
        null,
      );
      insertTask.run(
        'delete-terminal',
        'flow',
        'needs_attention',
        JSON.stringify({ chatId: 'chat-gone' }),
        'run-failed',
      );
      insertTask.run(
        'delete-live',
        'flow',
        'needs_attention',
        JSON.stringify({ chatId: 'chat-gone' }),
        'run-live',
      );
      insertTask.run(
        'keep-existing-chat',
        'flow',
        'needs_attention',
        JSON.stringify({ chatId: 'chat-live' }),
        'run-failed',
      );
      insertTask.run(
        'keep-manual',
        'manual',
        'needs_attention',
        JSON.stringify({ chatId: 'chat-gone' }),
        null,
      );
      insertTask.run(
        'delete-manual-nonobject-result',
        'manual',
        'needs_attention',
        JSON.stringify('legacy'),
        null,
      );
      insertTask.run('keep-chatless-flow', 'flow', 'needs_attention', '{}', 'run-failed');
      insertTask.run(
        'delete-legacy-result',
        'flow',
        'needs_attention',
        JSON.stringify(JSON.stringify({ chatId: 'chat-gone' })),
        'run-failed',
      );
      insertTask.run('delete-invalid-result', 'flow', 'needs_attention', 'not-json', 'run-failed');
      insertTask.run('delete-string-trigger-context', 'manual', 'needs_attention', '{}', null);
      insertTask.run('delete-invalid-trigger-context', 'manual', 'needs_attention', '{}', null);
      const seedTriggerContext = sqlite.prepare(
        'UPDATE tasks SET trigger_context = ? WHERE id = ?',
      );
      seedTriggerContext.run(
        JSON.stringify(JSON.stringify({ _config: { startMode: 'plan' } })),
        'delete-string-trigger-context',
      );
      seedTriggerContext.run('not-json', 'delete-invalid-trigger-context');
      seedTriggerContext.run(JSON.stringify({ _config: { startMode: 'plan' } }), 'keep-manual');

      const migrationSql = readFileSync(
        join(drizzleDir, '0089_prune_orphaned_flow_tasks.sql'),
        'utf-8',
      );
      sqlite.exec(migrationSql);
      sqlite.exec(migrationSql);

      // SAFETY: this projection returns only the seeded tasks.id TEXT column.
      const remaining = sqlite.prepare('SELECT id, result FROM tasks ORDER BY id').all() as Array<{
        id: string;
        result: string | null;
      }>;
      expect(remaining.map((row) => row.id)).toEqual([
        'keep-chatless-flow',
        'keep-existing-chat',
        'keep-manual',
      ]);
      expect(() =>
        insertTask.run(
          'reject-string-result',
          'flow',
          'pending',
          JSON.stringify('invalid'),
          'run-live',
        ),
      ).toThrow('task result must be a JSON object');
      expect(() =>
        sqlite
          .prepare('UPDATE tasks SET result = ? WHERE id = ?')
          .run(JSON.stringify('invalid'), 'keep-manual'),
      ).toThrow('task result must be a JSON object');
      expect(() =>
        sqlite
          .prepare('INSERT INTO tasks (id, source, status, trigger_context) VALUES (?, ?, ?, ?)')
          .run('reject-string-trigger-context', 'manual', 'pending', JSON.stringify('invalid')),
      ).toThrow('task trigger context must be a JSON object');
      expect(() =>
        sqlite
          .prepare('UPDATE tasks SET trigger_context = ? WHERE id = ?')
          .run(JSON.stringify('invalid'), 'keep-manual'),
      ).toThrow('task trigger context must be a JSON object');
    } finally {
      sqlite.close();
    }
  });

  it('drops every stored allow rule while deny and ask survive the narrowing', () => {
    const permissionRulesTag = '0097_permission_rules_drop_user_id';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === permissionRulesTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO user_permission_rules (id, user_id, rule_string, rule_type, created_at)
          VALUES ('r1', 'user-a', 'Read', 'allow', 1),
                 ('r2', 'user-b', 'Read', 'allow', 2),
                 ('r3', 'user-a', 'Bash(rm -rf:*)', 'deny', 3),
                 ('r4', 'user-b', 'Bash(rm -rf:*)', 'deny', 4),
                 ('r5', 'user-a', 'Write', 'ask', 5);
      `);

      sqlite.exec(readFileSync(join(drizzleDir, `${permissionRulesTag}.sql`), 'utf-8'));

      expect(columnNames(sqlite, 'user_permission_rules')).not.toContain('user_id');
      // SAFETY: this projection returns the seeded TEXT columns of the rules table.
      const rules = sqlite
        .prepare('SELECT rule_string, rule_type FROM user_permission_rules ORDER BY rule_string')
        .all() as Array<{ rule_string: string; rule_type: string }>;
      expect(rules).toEqual([
        { rule_string: 'Bash(rm -rf:*)', rule_type: 'deny' },
        { rule_string: 'Write', rule_type: 'ask' },
      ]);
      expect(() =>
        sqlite
          .prepare(
            'INSERT INTO user_permission_rules (id, rule_string, rule_type, created_at) VALUES (?, ?, ?, ?)',
          )
          .run('r6', 'Bash(rm -rf:*)', 'deny', 6),
      ).toThrow(/UNIQUE/);
    } finally {
      sqlite.close();
    }
  });

  it('collapses two owners onto one and keeps every dependent row', () => {
    const entries = readJournalEntries();
    const localRowsTag = '0098_local_rows_drop_user_id';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of entries) {
        if (entry.tag === localRowsTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      seedTwoOwners(sqlite);

      sqlite.exec(readFileSync(join(drizzleDir, `${localRowsTag}.sql`), 'utf-8'));

      expect(columnNames(sqlite, 'claude_code_credentials')).not.toContain('user_id');
      expect(columnNames(sqlite, 'claude_code_credentials')).not.toContain('cloud_account_id');
      for (const table of NARROWED_TABLES) {
        expect(columnNames(sqlite, table), table).not.toContain('user_id');
      }
      expect(tableNames(sqlite)).not.toContain('pending_account_syncs');
      expect(tableNames(sqlite)).not.toContain('user_integrations');
      expect(indexNames(sqlite)).toEqual(expect.arrayContaining(NARROWED_INDEXES));

      // One credential per (type, source, label), and the per-project override follows the survivor
      // instead of cascading away with the row it used to name.
      expect(count(sqlite, 'claude_code_credentials')).toBe(1);
      expect(count(sqlite, 'project_ai_accounts')).toBe(1);
      expect(count(sqlite, 'claude_code_credentials WHERE is_default = 1')).toBe(1);
      // A retried webhook delivery is still one task; the first delivery won.
      expect(count(sqlite, 'tasks')).toBe(1);
      expect(count(sqlite, 'plugin_installations')).toBe(1);
      expect(count(sqlite, 'plugin_connection_lifecycles')).toBe(2);
      expect(count(sqlite, 'flow_kv_state')).toBe(1);
      expect(count(sqlite, 'batch_plan_templates')).toBe(1);
      expect(count(sqlite, 'flow_trigger_bindings WHERE is_active = 1')).toBe(1);
      expect(count(sqlite, 'flow_trigger_bindings')).toBe(2);
    } finally {
      sqlite.close();
    }
  });

  it('deletes cursor credential rows and leaves the other providers untouched', () => {
    const dropCursorTag = '0099_drop_cursor_credentials';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === dropCursorTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/tmp/p'), ('p2', 'Q', '/tmp/q');
        INSERT INTO claude_code_credentials (id, type, account_label, is_default, source)
          VALUES ('cred-cursor', 'cursor', 'Cursor', 0, 'api-key'),
                 ('cred-claude', 'claude-code', 'Personal', 1, 'claude-passthrough');
        INSERT INTO project_ai_accounts (project_id, account_id)
          VALUES ('p1', 'cred-cursor'), ('p2', 'cred-claude');
      `);

      sqlite.exec(readFileSync(join(drizzleDir, `${dropCursorTag}.sql`), 'utf-8'));

      // SAFETY: this projection returns the seeded claude_code_credentials TEXT columns.
      const rows = sqlite
        .prepare('SELECT id, type FROM claude_code_credentials ORDER BY id')
        .all() as Array<{ id: string; type: string }>;
      expect(rows).toEqual([{ id: 'cred-claude', type: 'claude-code' }]);
      // The cascade is scoped to the deleted row: p1's override goes, p2's survivor override stays.
      // SAFETY: this projection returns the seeded project_ai_accounts TEXT columns.
      const overrides = sqlite
        .prepare('SELECT project_id, account_id FROM project_ai_accounts ORDER BY project_id')
        .all() as Array<{ project_id: string; account_id: string }>;
      expect(overrides).toEqual([{ project_id: 'p2', account_id: 'cred-claude' }]);
    } finally {
      sqlite.close();
    }
  });

  it('drops the github routing table and its credential rows, sparing the other providers', () => {
    const dropGithubTag = '0100_drop_github_credentials';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === dropGithubTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/tmp/p');
        INSERT INTO claude_code_credentials (id, type, account_label, is_default, source)
          VALUES ('cred-github', 'github', 'GitHub Cloud', 0, 'api-key'),
                 ('cred-claude', 'claude-code', 'Personal', 1, 'claude-passthrough'),
                 ('cred-codex', 'codex', 'Codex', 0, 'codex-passthrough');
        INSERT INTO project_github_accounts (project_id, account_label)
          VALUES ('p1', 'GitHub Cloud');
      `);

      sqlite.exec(readFileSync(join(drizzleDir, `${dropGithubTag}.sql`), 'utf-8'));

      expect(tableNames(sqlite)).not.toContain('project_github_accounts');
      // SAFETY: this projection returns the seeded claude_code_credentials TEXT columns.
      const rows = sqlite
        .prepare('SELECT id, type FROM claude_code_credentials ORDER BY id')
        .all() as Array<{ id: string; type: string }>;
      expect(rows).toEqual([
        { id: 'cred-claude', type: 'claude-code' },
        { id: 'cred-codex', type: 'codex' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('adds the local ingress tables and holds every endpoint constraint', () => {
    const ingressTag = '0101_local_webhook_ingress';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === ingressTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }

      sqlite.exec(readFileSync(join(drizzleDir, `${ingressTag}.sql`), 'utf-8'));

      expect(tableNames(sqlite)).toEqual(
        expect.arrayContaining(['integrations', 'integration_webhooks']),
      );
      expect(columnNames(sqlite, 'integrations')).not.toContain('user_id');
      expect(columnNames(sqlite, 'integration_webhooks')).not.toContain('user_id');
      sqlite.exec(`
        INSERT INTO integrations (id, provider, created_at, updated_at)
          VALUES ('i1', 'generic_webhook', 1, 1);
      `);
      const addEndpoint = sqlite.prepare(
        `INSERT INTO integration_webhooks
           (id, integration_id, provider, path_token, subscribe_key_encrypted,
            signing_secret_encrypted, created_at, updated_at)
         VALUES (?, ?, 'generic_webhook', ?, ?, ?, 1, 1)`,
      );
      const token = 'a'.repeat(64);

      expect(() => addEndpoint.run('w1', 'i1', 'a'.repeat(63), 'k', 's')).toThrow(/CHECK/);
      expect(() => addEndpoint.run('w1', 'i1', token, '', 's')).toThrow(/CHECK/);
      expect(() => addEndpoint.run('w1', 'i1', token, 'k', '')).toThrow(/CHECK/);
      expect(() => addEndpoint.run('w1', 'gone', token, 'k', 's')).toThrow(/FOREIGN KEY/);

      addEndpoint.run('w1', 'i1', token, 'k', 's');
      expect(() => addEndpoint.run('w2', 'i1', token, 'k', 's')).toThrow(/UNIQUE/);
      sqlite.exec("DELETE FROM integrations WHERE id = 'i1'");
      expect(count(sqlite, 'integration_webhooks')).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('adds the trigger operation lease and serialises one endpoint row', () => {
    const db = freshDb();
    try {
      const sqlite = db.$client;
      expect(columnNames(sqlite, 'integrations')).toContain('api_token_encrypted');
      expect(columnNames(sqlite, 'integration_webhooks')).toEqual(
        expect.arrayContaining(['operation_id', 'operation_expires_at']),
      );
      sqlite.exec(`
        INSERT INTO integrations (id, provider, created_at, updated_at)
          VALUES ('i1', 'posthog', 1, 1);
        INSERT INTO integration_webhooks
          (id, integration_id, provider, path_token, subscribe_key_encrypted,
           signing_secret_encrypted, created_at, updated_at)
          VALUES ('w1', 'i1', 'posthog', '${'a'.repeat(64)}', 'k', 's', 1, 1);
      `);
      const acquire = sqlite.prepare(
        `UPDATE integration_webhooks SET operation_id = ?, operation_expires_at = ?
         WHERE id = 'w1' AND (operation_id IS NULL OR operation_expires_at < ?)`,
      );
      const release = sqlite.prepare(
        `UPDATE integration_webhooks SET operation_id = NULL, operation_expires_at = NULL
         WHERE id = 'w1' AND operation_id = ?`,
      );

      expect(acquire.run('first', 2000, 1000).changes).toBe(1);
      expect(acquire.run('second', 2000, 1000).changes).toBe(0);
      expect(release.run('second').changes).toBe(0);
      expect(acquire.run('second', 9000, 5000).changes).toBe(1);
      expect(release.run('second').changes).toBe(1);
    } finally {
      db.$client.close();
    }
  });

  it('stamps every existing chat with the account it resolved to before', () => {
    const chatAccountTag = '0108_chat_account';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === chatAccountTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/tmp/p'), ('p2', 'Q', '/tmp/q');
        INSERT INTO claude_code_credentials (id, type, account_label, is_default, source)
          VALUES ('cred-default', 'claude-code', 'Personal', 1, 'claude-passthrough'),
                 ('cred-codex', 'codex', 'Codex', 0, 'codex-passthrough');
        INSERT INTO project_ai_accounts (project_id, account_id) VALUES ('p1', 'cred-codex');
        INSERT INTO chats (id, project_id) VALUES ('c1', 'p1'), ('c2', 'p2'), ('c3', NULL);
      `);

      sqlite.exec(readFileSync(join(drizzleDir, `${chatAccountTag}.sql`), 'utf-8'));

      // SAFETY: this projection returns the seeded chats TEXT columns.
      const rows = sqlite.prepare('SELECT id, account_id FROM chats ORDER BY id').all() as Array<{
        id: string;
        account_id: string | null;
      }>;
      expect(rows).toEqual([
        { id: 'c1', account_id: 'cred-codex' },
        { id: 'c2', account_id: 'cred-default' },
        { id: 'c3', account_id: 'cred-default' },
      ]);
      // A deleted login hands its chats to a same-provider login; with none left they un-stamp.
      sqlite.exec(`
        INSERT INTO claude_code_credentials (id, type, account_label, source)
          VALUES ('cred-work', 'claude-code', 'Work', 'api-key');
        DELETE FROM claude_code_credentials WHERE id IN ('cred-default', 'cred-codex');
      `);
      expect(count(sqlite, "chats WHERE account_id = 'cred-work'")).toBe(2);
      expect(count(sqlite, 'chats WHERE account_id IS NULL')).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("stamps every chat with the provider it resolves to and stops moving a deleted login's chats", () => {
    const chatProviderTag = '0109_chat_provider';
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === chatProviderTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/tmp/p'), ('p2', 'Q', '/tmp/q');
        INSERT INTO claude_code_credentials (id, type, account_label, is_default, source)
          VALUES ('cred-default', 'claude-code', 'Personal', 1, 'claude-passthrough'),
                 ('cred-codex', 'codex', 'Codex', 0, 'codex-passthrough');
        INSERT INTO project_ai_accounts (project_id, account_id) VALUES ('p1', 'cred-codex');
        INSERT INTO chats (id, project_id, account_id)
          VALUES ('stamped', 'p2', 'cred-codex'), ('override', 'p1', NULL),
                 ('default', 'p2', NULL), ('general', NULL, NULL);
      `);

      sqlite.exec(readFileSync(join(drizzleDir, `${chatProviderTag}.sql`), 'utf-8'));

      // SAFETY: this projection returns the seeded chats TEXT columns.
      const rows = sqlite.prepare('SELECT id, provider FROM chats ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'default', provider: 'claude-code' },
        { id: 'general', provider: 'claude-code' },
        { id: 'override', provider: 'codex' },
        { id: 'stamped', provider: 'codex' },
      ]);
      sqlite.exec("DELETE FROM claude_code_credentials WHERE id = 'cred-codex'");
      sqlite.exec("INSERT INTO chats (id) VALUES ('fresh')");
      expect(count(sqlite, "chats WHERE provider = 'codex' AND account_id IS NULL")).toBe(2);
      expect(count(sqlite, "chats WHERE id = 'fresh' AND provider = 'claude-code'")).toBe(1);
      // SAFETY: sqlite_master.name is TEXT and this query projects that single non-null column.
      const triggers = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'claude_code_credentials'",
        )
        .all();
      expect(triggers).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('moves every transcript into one row per message and drops the column', () => {
    const subChatMessagesTag = '0111_sub_chat_messages';
    const transcripts: Record<string, string> = {
      metadata: JSON.stringify([
        { id: 'a1', role: 'assistant', parts: [], metadata: { sdkMessageUuid: 'sdk-1' } },
      ]),
      partial: JSON.stringify([
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'a1', role: 'assistant' },
      ]),
      duplicates: JSON.stringify([
        { id: 'm1', role: 'user', parts: [] },
        { id: 'm1', role: 'assistant', parts: [] },
      ]),
      holes: JSON.stringify([{ id: 'm1' }, null, { id: 'm2' }]),
      corrupt: '{not json',
    };
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === subChatMessagesTag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec("INSERT INTO chats (id) VALUES ('c1')");
      const insert = sqlite.prepare(
        'INSERT INTO sub_chats (id, chat_id, messages) VALUES (?, ?, ?)',
      );
      for (const [id, raw] of Object.entries(transcripts)) insert.run(id, 'c1', raw);

      sqlite.exec(readFileSync(join(drizzleDir, `${subChatMessagesTag}.sql`), 'utf-8'));

      expect(columnNames(sqlite, 'sub_chats')).not.toContain('messages');
      // SAFETY: this projection returns the sub_chat_messages columns, all non-null.
      const rows = sqlite
        .prepare('SELECT sub_chat_id, seq, message FROM sub_chat_messages ORDER BY seq')
        .all() as Array<{ sub_chat_id: string; seq: number; message: string }>;
      for (const [id, raw] of Object.entries(transcripts)) {
        const own = rows.filter((row) => row.sub_chat_id === id);
        const expected = id === 'corrupt' ? [] : (JSON.parse(raw) as unknown[]);
        expect(
          own.map((row) => row.seq),
          id,
        ).toEqual(own.map((_, seq) => seq));
        expect(
          own.map((row) => JSON.parse(row.message)),
          id,
        ).toEqual(expected.filter((message) => message !== null));
      }
      sqlite.exec("DELETE FROM sub_chats WHERE id = 'metadata'");
      expect(count(sqlite, "sub_chat_messages WHERE sub_chat_id = 'metadata'")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('strips the retired continuation flag from queued resume intents', () => {
    const tag = '0112_resume_intent_continuation';
    const resume = { version: 1, action: 'resume', flow_run_id: 'run-1', node_run_id: 'nr-1' };
    const sqlite = new NodeSqliteDatabase(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const entry of readJournalEntries()) {
        if (entry.tag === tag) break;
        sqlite.exec(readFileSync(join(drizzleDir, `${entry.tag}.sql`), 'utf-8'));
      }
      sqlite.exec(`
        INSERT INTO flows (id, name) VALUES ('flow-1', 'F');
        INSERT INTO flow_versions (id, flow_id, version_number, graph) VALUES ('ver-1', 'flow-1', 1, '{}');
        INSERT INTO flow_runs (id, flow_version_id, status)
          VALUES ('run-1', 'ver-1', 'failed'), ('run-2', 'ver-1', 'failed');
      `);
      const insert = sqlite.prepare(
        "INSERT INTO flow_run_admissions (flow_run_id, priority_class, intent_version, intent_json, requested_at) VALUES (?, 'resume', 1, ?, 1)",
      );
      insert.run('run-1', JSON.stringify({ ...resume, continuation: true }));
      insert.run('run-2', JSON.stringify({ ...resume, flow_run_id: 'run-2' }));

      sqlite.exec(readFileSync(join(drizzleDir, `${tag}.sql`), 'utf-8'));

      // SAFETY: this projection returns the seeded admissions' TEXT intent_json column.
      const rows = sqlite
        .prepare('SELECT intent_json FROM flow_run_admissions ORDER BY flow_run_id')
        .all() as Array<{ intent_json: string }>;
      const intents: unknown[] = rows.map((row) => JSON.parse(row.intent_json));
      expect(intents).toEqual([resume, { ...resume, flow_run_id: 'run-2' }]);
      expect(intents.every(isFlowAdmissionIntentV1)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('leaves no dropped column or table behind after the real migration runner', () => {
    const db = freshDb();
    try {
      const sqlite = db.$client;
      expect(columnNames(sqlite, 'claude_code_credentials')).not.toContain('user_id');
      expect(columnNames(sqlite, 'claude_code_credentials')).not.toContain('cloud_account_id');
      for (const table of NARROWED_TABLES) {
        expect(columnNames(sqlite, table), table).not.toContain('user_id');
      }
      expect(tableNames(sqlite)).not.toContain('pending_account_syncs');
      expect(tableNames(sqlite)).not.toContain('user_integrations');
      expect(tableNames(sqlite)).not.toContain('project_github_accounts');
    } finally {
      db.$client.close();
    }
  });

  it('applies every task payload guard through the real migration runner', () => {
    const db = freshDb();
    try {
      // SAFETY: sqlite_master.name is TEXT and this query projects that single non-null column.
      const triggers = db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'tasks_*_object_*' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      expect(triggers.map((trigger) => trigger.name)).toEqual([
        'tasks_result_object_insert',
        'tasks_result_object_update',
        'tasks_trigger_context_object_insert',
        'tasks_trigger_context_object_update',
      ]);
    } finally {
      db.$client.close();
    }
  });
});
