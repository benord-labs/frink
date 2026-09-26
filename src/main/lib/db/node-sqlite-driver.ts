import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * better-sqlite3-shaped driver over Node's built-in `node:sqlite` (bundled with
 * Electron's Node, so it is ABI-free: no native binary, no electron-rebuild, no
 * dev/test ABI flipping). Exposes ONLY the surface our code and Drizzle's
 * better-sqlite3 session actually call — prepare (run/get/all/raw), exec, pragma,
 * transaction (callable, with the deferred/immediate/exclusive variants), close.
 *
 * INTERIM adapter: drizzle-orm ships an official node:sqlite driver on its 1.0 line
 * (drizzle-team/drizzle-orm#5464); this file's exit condition is adopting it when
 * frink moves off the 0.45 line. Peer-proven shape meanwhile (codegraph
 * sqlite-adapter.ts, cline sqlite-db.ts, t3code NodeSqliteClient.ts).
 *
 * Faithfulness notes:
 * - `raw()` maps to `StatementSync.setReturnArrays(true)`: engine-level array rows,
 *   so duplicate column names in joins keep every value (object rows collapse them —
 *   the exact reason Drizzle selects with raw mode).
 * - `timeout: 5000` preserves better-sqlite3's busy_timeout default; node:sqlite
 *   defaults to 0, which would silently drop lock-wait behaviour.
 * - Drizzle nests transactions via its own savepoints; only the OUTER
 *   begin/commit/rollback happens here, mirroring better-sqlite3's wrapper.
 */

type SqlParams = SQLInputValue[];

/**
 * node:sqlite's typings model the optional leading named-parameters record as a
 * required first argument, rejecting the zero-arg and purely positional calls the
 * runtime accepts (and which Drizzle and our callers use exclusively) — retype the
 * statement to the positional surface.
 */
type PositionalStatement = {
  run: (...params: SqlParams) => ReturnType<StatementSync['run']>;
  get: (...params: SqlParams) => unknown;
  all: (...params: SqlParams) => unknown[];
  setReturnArrays: (returnArrays: boolean) => void;
};

class NodeSqliteStatement {
  private readonly stmt: PositionalStatement;

  constructor(stmt: StatementSync) {
    this.stmt = stmt as unknown as PositionalStatement;
  }

  run(...params: SqlParams) {
    return this.stmt.run(...params);
  }

  get(...params: SqlParams) {
    return this.stmt.get(...params);
  }

  all(...params: SqlParams) {
    return this.stmt.all(...params);
  }

  raw(on = true): this {
    this.stmt.setReturnArrays(on);
    return this;
  }
}

export class NodeSqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
  }

  prepare(sql: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** `PRAGMA <source>`; `simple` returns the first column of the first row, as better-sqlite3 did. */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const stmt = this.prepare(`PRAGMA ${source}`);
    if (options?.simple) {
      return (stmt.raw().get() as unknown[] | undefined)?.[0];
    }
    return stmt.all();
  }

  /** Callable transaction wrapper: `db.transaction(fn)(...args)` runs fn inside BEGIN/COMMIT. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const wrap =
      (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
      (...args: A): R => {
        this.db.exec(`BEGIN ${mode}`);
        try {
          const result = fn(...args);
          this.db.exec('COMMIT');
          return result;
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      };
    return Object.assign(wrap('DEFERRED'), {
      deferred: wrap('DEFERRED'),
      immediate: wrap('IMMEDIATE'),
      exclusive: wrap('EXCLUSIVE'),
    });
  }

  close(): void {
    this.db.close();
  }
}
