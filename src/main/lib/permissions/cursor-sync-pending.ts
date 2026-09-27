/**
 * Project-rule → `.cursor/cli.json` sync: DB-checked reconcile with in-call retries, plus a durable
 * queue (`<userData>/cursor-sync-pending.json`) for syncs that still fail, replayed on boot.
 */

import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import type { getDatabase } from '../db';
import { getProjectById } from '../db/repos/projects';
import { reconcileBashRuleInCursorConfig } from './cursor-config-sync';
import { hasProjectAllowRuleIgnoringPadding } from './v2/store-local';

type Db = ReturnType<typeof getDatabase>;
type PendingSync = { projectId: string; ruleString: string };

const CURSOR_SYNC_ATTEMPTS = 3;

/** Reconcile the rule's Shell(...) token against the DB allow list, retrying transient failures. */
export async function syncProjectRuleToCursor(
  db: Db,
  project: { id: string; path: string },
  ruleString: string,
  { retryDelayMs = 100 }: { retryDelayMs?: number } = {},
): Promise<void> {
  const isAllowed = () => hasProjectAllowRuleIgnoringPadding(db, project.id, ruleString);
  for (let attempt = 1; ; attempt++) {
    try {
      await reconcileBashRuleInCursorConfig(project.path, ruleString, isAllowed);
      return;
    } catch (err) {
      if (attempt >= CURSOR_SYNC_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

export function defaultPendingFile(): string {
  return join(app.getPath('userData'), 'cursor-sync-pending.json');
}

let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => {}).then(fn);
  queue = run.catch(() => {});
  return run;
}

async function readPending(file: string): Promise<PendingSync[]> {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PendingSync =>
        typeof e?.projectId === 'string' && typeof e?.ruleString === 'string',
    );
  } catch (err) {
    log.warn(`[Cursor Config] Ignoring unreadable pending-sync file ${file}:`, err);
    return [];
  }
}

const same = (a: PendingSync) => (b: PendingSync) =>
  a.projectId === b.projectId && a.ruleString === b.ruleString;

async function update(file: string, fn: (entries: PendingSync[]) => PendingSync[]): Promise<void> {
  await serialised(async () => {
    const before = await readPending(file);
    const after = fn(before);
    if (after.length === before.length && after.every((e, i) => same(e)(before[i]))) return;
    // Write-then-rename so a crash mid-write can never leave a truncated queue behind.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(after, null, 2)}\n`, 'utf-8');
    await rename(tmp, file);
  });
}

export function listPendingCursorSyncs(file = defaultPendingFile()): Promise<PendingSync[]> {
  return serialised(() => readPending(file));
}

// One in-flight durable sync per (project, rule): a slow success can't clear a newer failure's entry.
const perRule = new Map<string, Promise<void>>();

/**
 * Sync a project rule to Cursor; on final failure queue it for the boot sweep instead of dropping
 * it. Never throws — the SQLite row is the source of truth.
 */
export function syncProjectRuleToCursorDurably(
  db: Db,
  projectId: string,
  ruleString: string,
  opts: { file?: string; retryDelayMs?: number } = {},
): Promise<void> {
  const key = JSON.stringify([projectId, ruleString]);
  const run = (perRule.get(key) ?? Promise.resolve()).then(() =>
    syncOnce(db, projectId, ruleString, opts),
  );
  perRule.set(key, run);
  void run.then(() => {
    if (perRule.get(key) === run) perRule.delete(key);
  });
  return run;
}

async function syncOnce(
  db: Db,
  projectId: string,
  ruleString: string,
  { file = defaultPendingFile(), retryDelayMs }: { file?: string; retryDelayMs?: number } = {},
): Promise<void> {
  const entry = { projectId, ruleString };
  try {
    const project = await getProjectById(db, projectId);
    if (project) await syncProjectRuleToCursor(db, project, ruleString, { retryDelayMs });
    await update(file, (entries) => entries.filter((e) => !same(entry)(e)));
  } catch (err) {
    log.warn(
      '[Cursor Config] Sync failed; queued for retry on next launch:',
      err instanceof Error ? err.message : String(err),
    );
    try {
      await update(file, (entries) => (entries.some(same(entry)) ? entries : [...entries, entry]));
    } catch (queueErr) {
      log.error('[Cursor Config] Could not persist pending sync:', queueErr);
    }
  }
}

/** Boot sweep: replay queued syncs; drops entries that succeed or whose project is gone. */
export async function retryPendingCursorSyncs(
  db: Db,
  { file = defaultPendingFile(), retryDelayMs }: { file?: string; retryDelayMs?: number } = {},
): Promise<void> {
  const pending = await listPendingCursorSyncs(file);
  for (const entry of pending) {
    await syncProjectRuleToCursorDurably(db, entry.projectId, entry.ruleString, {
      file,
      retryDelayMs,
    });
  }
}
