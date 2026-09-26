import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { drizzleNodeSqlite } from './drizzle-node-sqlite';
import { NodeSqliteDatabase } from './node-sqlite-driver';
import {
  type NormalizeStats,
  normalizeMessagesJson,
  normalizeToolPartStates,
} from './normalize-tool-part-states';
import * as schema from './schema';

const DRIZZLE_DIR = join(__dirname, '../../../../drizzle');

function stats(): NormalizeStats {
  return { states: 0, mirrors: 0 };
}

function messages(parts: unknown[]): string {
  return JSON.stringify([{ id: 'm1', role: 'assistant', parts }]);
}

function partsOf(json: string): Record<string, unknown>[] {
  return (JSON.parse(json) as { parts: Record<string, unknown>[] }[])[0].parts;
}

describe('normalizeMessagesJson', () => {
  it('renames the legacy terminal state to the one the SDK defines', () => {
    const out = normalizeMessagesJson(
      messages([{ type: 'tool-Bash', state: 'result', output: { stdout: 'ok' } }]),
      stats(),
    );

    expect(partsOf(out ?? '')[0].state).toBe('output-available');
  });

  it('drops the result mirror when output already carries the same payload', () => {
    const out = normalizeMessagesJson(
      messages([
        { type: 'tool-Bash', state: 'result', output: { stdout: 'ok' }, result: { stdout: 'ok' } },
      ]),
      stats(),
    );

    expect(partsOf(out ?? '')[0]).not.toHaveProperty('result');
    expect(partsOf(out ?? '')[0].output).toEqual({ stdout: 'ok' });
  });

  it('keeps a result that has no output to replace it', () => {
    // The AskUserQuestion closed reason is a bare string and `output` is typed as a record, so this
    // payload has nowhere else to live. Dropping it blanks the "Skipped" line on reload.
    const out = normalizeMessagesJson(
      messages([{ type: 'tool-AskUserQuestion', state: 'result', result: 'Skipped' }]),
      stats(),
    );

    expect(partsOf(out ?? '')[0]).toMatchObject({ state: 'output-available', result: 'Skipped' });
  });

  it('reports no change for an already-migrated row, so it is never rewritten', () => {
    const already = messages([
      { type: 'tool-Bash', state: 'output-available', output: { stdout: 'ok' } },
    ]);

    expect(normalizeMessagesJson(already, stats())).toBeNull();
  });

  it('is a fixed point when run twice', () => {
    const first = normalizeMessagesJson(
      messages([
        { type: 'tool-Bash', state: 'result', output: { stdout: 'ok' }, result: { stdout: 'ok' } },
      ]),
      stats(),
    );

    expect(normalizeMessagesJson(first ?? '', stats())).toBeNull();
  });

  it('leaves text parts and other states alone', () => {
    const untouched = messages([
      { type: 'text', text: 'hello' },
      { type: 'tool-Read', state: 'input-available' },
      { type: 'tool-Bash', state: 'output-error', errorText: 'boom' },
    ]);

    expect(normalizeMessagesJson(untouched, stats())).toBeNull();
  });

  it('throws on unparseable JSON so the caller can skip rather than clobber the row', () => {
    expect(() => normalizeMessagesJson('{not json', stats())).toThrow();
  });

  it('counts what it changed', () => {
    const counters = stats();
    normalizeMessagesJson(
      messages([
        { type: 'tool-Bash', state: 'result', output: { a: 1 }, result: { a: 1 } },
        { type: 'tool-Read', state: 'result', output: { b: 2 } },
      ]),
      counters,
    );

    expect(counters).toEqual({ states: 2, mirrors: 1 });
  });
});

describe('normalizeToolPartStates (real sqlite)', () => {
  function seed(messages: unknown): { sqlite: NodeSqliteDatabase; id: string } {
    const sqlite = new NodeSqliteDatabase(':memory:');
    migrate(drizzleNodeSqlite(sqlite, schema), { migrationsFolder: DRIZZLE_DIR });
    const id = 'sub-1';
    sqlite
      .prepare("INSERT INTO chats (id, name, created_at, updated_at) VALUES ('chat-1', 'c', 1, 1)")
      .run();
    sqlite
      .prepare(
        'INSERT INTO sub_chats (id, chat_id, name, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        'chat-1',
        's',
        typeof messages === 'string' ? messages : JSON.stringify(messages),
        1,
        7,
      );
    return { sqlite, id };
  }

  const legacy = [
    {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'tool-Bash', state: 'result', output: { ok: 1 } }],
    },
  ];

  const readState = (sqlite: NodeSqliteDatabase, id: string): string => {
    const row = sqlite.prepare('SELECT messages FROM sub_chats WHERE id = ?').get(id) as {
      messages: string;
    };
    return row.messages;
  };
  const version = (sqlite: NodeSqliteDatabase): number =>
    sqlite.pragma('user_version', { simple: true }) as number;

  it('rewrites legacy rows and claims the ledger from the version below', () => {
    const { sqlite, id } = seed(legacy);
    sqlite.pragma('user_version = 2');

    normalizeToolPartStates(sqlite);

    expect(readState(sqlite, id)).toContain('output-available');
    expect(readState(sqlite, id)).not.toContain('"result"');
    expect(version(sqlite)).toBe(3);
  });

  // A sweep that aborts leaves the ledger unbumped so it retries next launch. Claiming the ledger
  // from below would satisfy its `>=` gate on its behalf and retire that retry for good.
  it('does not claim the ledger over a lower sweep that has not run', () => {
    const { sqlite, id } = seed(legacy);
    sqlite.pragma('user_version = 1');

    normalizeToolPartStates(sqlite);

    expect(readState(sqlite, id)).toContain('output-available');
    expect(version(sqlite)).toBe(1);
  });

  it('skips entirely once the ledger is already claimed', () => {
    const { sqlite, id } = seed(legacy);
    sqlite.pragma('user_version = 3');

    normalizeToolPartStates(sqlite);

    expect(readState(sqlite, id)).toContain('"state":"result"');
  });

  it('leaves an unparseable row byte-identical rather than erasing the chat', () => {
    const corrupt = '{not json — "state":"result"';
    const { sqlite, id } = seed(corrupt);
    sqlite.pragma('user_version = 2');

    normalizeToolPartStates(sqlite);

    expect(readState(sqlite, id)).toBe(corrupt);
  });

  it('never touches updated_at, which orders the chat list', () => {
    const { sqlite, id } = seed(legacy);
    sqlite.pragma('user_version = 2');

    normalizeToolPartStates(sqlite);

    const row = sqlite.prepare('SELECT updated_at FROM sub_chats WHERE id = ?').get(id) as {
      updated_at: number;
    };
    expect(row.updated_at).toBe(7);
  });
});
