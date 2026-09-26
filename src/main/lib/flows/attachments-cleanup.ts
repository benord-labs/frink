/**
 * Startup orphan sweep for flow run attachments. Lists every directory under
 * `userData/flow-attachments/<runId>/` and removes any whose `runId` is no
 * longer present in `batch_stage_runs` — handles the case where a stage_run
 * was deleted (cascade from flow / version / batch) but the on-disk bytes
 * stayed behind.
 *
 * Best-effort. Never throws; logs and moves on so app boot stays resilient.
 */

import { existsSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import { getDatabase } from '../db';
import { batchStageRuns } from '../db/schema';

/** Cuid2 IDs only — `[a-z0-9]{20,32}` is conservative; never relax to allow path chars. */
const SAFE_RUN_ID_RE = /^[A-Za-z0-9]+$/;

export async function sweepOrphanedAttachments(): Promise<{ scanned: number; removed: number }> {
  const root = join(app.getPath('userData'), 'flow-attachments');
  if (!existsSync(root)) return { scanned: 0, removed: 0 };

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    log.warn('[FlowsAttachments] sweep readdir failed', { root, err });
    return { scanned: 0, removed: 0 };
  }

  if (entries.length === 0) return { scanned: 0, removed: 0 };

  const db = getDatabase();
  const rows = await db.select({ id: batchStageRuns.id }).from(batchStageRuns);
  const liveIds = new Set(rows.map((r) => r.id));

  let removed = 0;
  for (const runId of entries) {
    if (liveIds.has(runId)) continue;
    // Skip filesystem entries that don't look like cuid2 run IDs (.DS_Store,
    // future manifest files, accidental sibling dirs).
    if (!SAFE_RUN_ID_RE.test(runId)) {
      log.warn('[FlowsAttachments] sweep skipping non-runId entry', { entry: runId });
      continue;
    }
    const full = join(root, runId);
    // lstat (not stat) so we never follow a symlink. A malicious symlink under
    // flow-attachments/ that points at userData/logs would otherwise let
    // rm({ recursive: true }) delete a sibling directory.
    let isPlainDir = false;
    try {
      const stat = await lstat(full);
      isPlainDir = stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      continue;
    }
    if (!isPlainDir) {
      log.warn('[FlowsAttachments] sweep skipping non-directory entry', { entry: runId });
      continue;
    }
    try {
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn('[FlowsAttachments] sweep rm failed', { runId, err });
    }
  }

  if (removed > 0) {
    log.info('[FlowsAttachments] sweep removed orphans', { scanned: entries.length, removed });
  }
  return { scanned: entries.length, removed };
}
