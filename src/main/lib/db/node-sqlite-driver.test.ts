import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { drizzleNodeSqlite } from './drizzle-node-sqlite';
import { NodeSqliteDatabase } from './node-sqlite-driver';

// A value import of the drizzle-orm/better-sqlite3 ENTRYPOINT (subpaths are fine).
const DIRTY_ENTRYPOINT_IMPORT = /^import (?!type ).*from 'drizzle-orm\/better-sqlite3';$/m;

describe('NodeSqliteDatabase', () => {
  it('preserves better-sqlite3 busy_timeout default (node:sqlite alone defaults to 0)', () => {
    const db = new NodeSqliteDatabase(':memory:');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('returns engine-level array rows in raw mode, keeping join-collided column values', () => {
    const db = new NodeSqliteDatabase(':memory:');
    db.exec(
      'create table a(id int, name text); create table b(id int, name text);' +
        " insert into a values (1, 'alice'); insert into b values (1, 'bob')",
    );
    const stmt = db.prepare('select a.name, b.name from a join b on a.id = b.id');
    expect(stmt.raw().get()).toEqual(['alice', 'bob']);
    db.close();
  });

  it('rolls the transaction back when the callback throws', () => {
    const db = new NodeSqliteDatabase(':memory:');
    db.exec('create table t(v text)');
    const tx = db.transaction((v: string) => {
      db.prepare('insert into t values (?)').run(v);
      throw new Error('abort');
    });
    expect(() => tx('x')).toThrow('abort');
    expect(db.prepare('select count(*) as n from t').get()).toEqual({ n: 0 });
    db.close();
  });

  it('surfaces the original error when SQLite already rolled back the whole transaction', () => {
    const db = new NodeSqliteDatabase(':memory:');
    db.exec(
      'create table t(v text);' +
        " create trigger boom before insert on t begin select raise(rollback, 'boom'); end",
    );
    const inner = db.transaction(() => db.prepare('insert into t values (1)').run());
    expect(() => db.transaction(() => inner())()).toThrow('boom');
    db.close();
  });

  describe('transaction nesting and the synchronous-body guard', () => {
    const table = sqliteTable('t', { v: text('v') });
    const setup = () => {
      const db = new NodeSqliteDatabase(':memory:');
      db.exec('create table t(v text)');
      const insert = (v: string) => db.prepare('insert into t values (?)').run(v);
      const values = () => db.prepare('select v from t order by v').raw().all().flat();
      return { db, insert, values };
    };

    it('throws on an async body and rolls back what it wrote before its first await', () => {
      const { db, insert, values } = setup();
      const tx = db.transaction(async () => {
        insert('before-await');
        await Promise.resolve();
      });
      expect(() => tx()).toThrow('must be synchronous');
      expect(values()).toEqual([]);
      expect(() => db.transaction(() => insert('after'))()).not.toThrow();
      db.close();
    });

    it('throws on a body that returns an unexecuted Drizzle builder', () => {
      const { db: sqlite } = setup();
      const db = drizzleNodeSqlite(sqlite, { table });
      expect(() => db.transaction(() => db.select().from(table))).toThrow('must be synchronous');
      sqlite.close();
    });

    it('commits a nested transaction together with the outer one', () => {
      const { db, insert, values } = setup();
      db.transaction(() => {
        insert('outer');
        db.transaction(() => insert('inner')).immediate();
      }).immediate();
      expect(values()).toEqual(['inner', 'outer']);
      db.close();
    });

    it('rolls back only the nested savepoint when it throws, leaving the outer to commit', () => {
      const { db, insert, values } = setup();
      db.transaction(() => {
        insert('outer');
        expect(() =>
          db.transaction(() => {
            insert('inner');
            throw new Error('inner failed');
          })(),
        ).toThrow('inner failed');
        db.transaction(() => insert('sibling'))();
      })();
      expect(values()).toEqual(['outer', 'sibling']);
      db.close();
    });

    it('rolls back the nested writes too when the outer transaction throws', () => {
      const { db, insert, values } = setup();
      expect(() =>
        db.transaction(() => {
          db.transaction(() => insert('inner'))();
          throw new Error('outer failed');
        })(),
      ).toThrow('outer failed');
      expect(values()).toEqual([]);
      db.close();
    });
  });

  it('exposes the raw client as $client on the drizzle instance', () => {
    const sqlite = new NodeSqliteDatabase(':memory:');
    const db = drizzleNodeSqlite(sqlite, {});
    expect(db.$client).toBe(sqlite);
    sqlite.close();
  });
});

describe('better-sqlite3 stays out of the runtime', () => {
  it('loads none of the composition subpaths through the native module', () => {
    // The drizzle-orm/better-sqlite3 ENTRYPOINT requires better-sqlite3 unconditionally,
    // even when handed a foreign client. The composition must only touch the clean
    // subpaths — probed in a child process where require.cache is authoritative.
    const probe = `
      const { createRequire } = require('node:module');
      const req = createRequire(process.env.PROBE_ROOT + '/package.json');
      req('drizzle-orm');
      req('drizzle-orm/better-sqlite3/session');
      req('drizzle-orm/sqlite-core');
      req('drizzle-orm/better-sqlite3/migrator');
      const dirty = Object.keys(require.cache).filter((k) => /node_modules[\\\\/]better-sqlite3[\\\\/]/.test(k));
      if (dirty.length > 0) { console.error(dirty.join('\\n')); process.exit(1); }
    `;
    execFileSync(process.execPath, ['--no-warnings', '-e', probe], {
      env: { ...process.env, PROBE_ROOT: process.cwd() },
      stdio: 'pipe',
    });
  });

  it('db sources import the drizzle better-sqlite3 entrypoint as type-only', () => {
    for (const file of ['index.ts', 'drizzle-node-sqlite.ts', 'test-utils/fresh-db.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect(src, `${file} must not value-import drizzle-orm/better-sqlite3`).not.toMatch(
        DIRTY_ENTRYPOINT_IMPORT,
      );
    }
  });
});
