/**
 * Startup orphan sweep for flow run attachments. Lists every directory under
 * `userData/flow-attachments/<runId>/` and removes any whose `runId` is no
 * longer present in `batch_stage_runs` — handles the case where a stage_run
 * was deleted (cascade from flow / version / batch) but the on-disk bytes
 * stayed behind.
 *
 * Also drops files inside live run directories that no stage run, flow run or task
 * trigger_context references (crashed uploads, removed attachments).
 *
 * Best-effort. Never throws; logs and moves on so app boot stays resilient.
 */

import { existsSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import log from 'electron-log';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase } from '../db';
import { batchStageRuns, flowRuns, tasks } from '../db/schema';
import { attachmentsRoot, parseAttachmentUrl } from './attachments-storage';

/** Cuid2 IDs only — `[a-z0-9]{20,32}` is conservative; never relax to allow path chars. */
const SAFE_RUN_ID_RE = /^[A-Za-z0-9]+$/;
/** Keeps each IN list well under SQLite's bound-parameter limit. */
const ID_CHUNK = 500;
/** Mirrors attachments-storage SAFE_NAME_RE — only names an upload could have written. */
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Attachment URLs of a stored trigger_context; malformed entries read as null. */
const attachmentUrlsSchema = z
  .object({
    attachments: z.array(z.object({ url: z.string() }).nullable().catch(null)).catch([]),
  })
  .catch({ attachments: [] });

/** Every `<runId>/<filename>` any row references — global, since a row may point at another run's file. */
function referencedAttachmentKeys(rows: Array<{ triggerContext: unknown }>): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const entry of attachmentUrlsSchema.parse(row.triggerContext).attachments) {
      const parsed = entry && parseAttachmentUrl(entry.url);
      if (parsed) keys.add(`${parsed.runId}/${parsed.filename}`);
    }
  }
  return keys;
}

/** Remove plain files in a live run's directory that no row references. Returns the count removed. */
async function sweepUnreferencedFiles(
  runDir: string,
  runId: string,
  referenced: Set<string>,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch (err) {
    log.warn('[FlowsAttachments] sweep readdir failed', { runDir, err });
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SAFE_FILE_NAME_RE.test(name) || referenced.has(`${runId}/${name}`)) continue;
    const full = join(runDir, name);
    try {
      // lstat: never follow or delete through a symlink.
      if (!(await lstat(full)).isFile()) continue;
      await rm(full, { force: true });
      removed += 1;
    } catch (err) {
      log.warn('[FlowsAttachments] sweep file rm failed', { runId, name, err });
    }
  }
  return removed;
}

type Db = ReturnType<typeof getDatabase>;

/**
 * Flow runs and tasks that dispatch copied attachments into. Indexed lookups only: by id for
 * live stage runs, and by idempotency key (= stage run id) for stage runs whose row is gone.
 */
async function loadDispatchedCopies(
  db: Db,
  liveFlowRunIds: string[],
  goneRunIds: string[],
): Promise<Array<{ triggerContext: unknown }>> {
  const flowCopies: Array<{ id: string; triggerContext: unknown }> = [];
  for (let i = 0; i < liveFlowRunIds.length; i += ID_CHUNK) {
    const chunk = liveFlowRunIds.slice(i, i + ID_CHUNK);
    flowCopies.push(
      ...(await db
        .select({ id: flowRuns.id, triggerContext: flowRuns.triggerContext })
        .from(flowRuns)
        .where(inArray(flowRuns.id, chunk))),
    );
  }
  for (let i = 0; i < goneRunIds.length; i += ID_CHUNK) {
    const chunk = goneRunIds.slice(i, i + ID_CHUNK);
    flowCopies.push(
      ...(await db
        .select({ id: flowRuns.id, triggerContext: flowRuns.triggerContext })
        .from(flowRuns)
        .where(inArray(flowRuns.idempotencyKey, chunk))),
    );
  }
  const flowRunIds = flowCopies.map((r) => r.id);
  const taskCopies: Array<{ triggerContext: unknown }> = [];
  for (let i = 0; i < flowRunIds.length; i += ID_CHUNK) {
    const chunk = flowRunIds.slice(i, i + ID_CHUNK);
    taskCopies.push(
      ...(await db
        .select({ triggerContext: tasks.triggerContext })
        .from(tasks)
        .where(inArray(tasks.flowRunId, chunk))),
    );
  }
  return [...flowCopies, ...taskCopies];
}

/** lstat, never stat: a symlink under flow-attachments/ must not let rm reach outside it. */
async function isPlainDirectory(full: string): Promise<boolean> {
  try {
    const stat = await lstat(full);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

type SweepRefs = { liveIds: Set<string>; referenced: Set<string>; referencedRunIds: Set<string> };

async function loadSweepRefs(db: Db, entries: string[]): Promise<SweepRefs> {
  const rows = await db
    .select({
      id: batchStageRuns.id,
      flowRunId: batchStageRuns.flowRunId,
      triggerContext: batchStageRuns.triggerContext,
    })
    .from(batchStageRuns);
  const liveIds = new Set(rows.map((r) => r.id));
  const onDisk = new Set(entries);
  const goneRunIds = entries.filter((id) => !liveIds.has(id) && SAFE_RUN_ID_RE.test(id));
  const liveFlowRunIds = rows.flatMap((r) =>
    r.flowRunId && onDisk.has(r.id) ? [r.flowRunId] : [],
  );
  const copies = await loadDispatchedCopies(db, liveFlowRunIds, goneRunIds);
  const referenced = referencedAttachmentKeys([...rows, ...copies]);
  const referencedRunIds = new Set([...referenced].map((key) => key.split('/')[0]));
  return { liveIds, referenced, referencedRunIds };
}

/** Sweep one top-level entry; returns how many directories and files it removed. */
async function sweepEntry(
  root: string,
  runId: string,
  refs: SweepRefs,
): Promise<{ removed: number; removedFiles: number }> {
  const none = { removed: 0, removedFiles: 0 };
  const full = join(root, runId);
  const live = refs.liveIds.has(runId);
  // Skip filesystem entries that don't look like cuid2 run IDs (.DS_Store,
  // future manifest files, accidental sibling dirs).
  if (!live && !SAFE_RUN_ID_RE.test(runId)) {
    log.warn('[FlowsAttachments] sweep skipping non-runId entry', { entry: runId });
    return none;
  }
  if (!(await isPlainDirectory(full))) {
    if (!live) log.warn('[FlowsAttachments] sweep skipping non-directory entry', { entry: runId });
    return none;
  }
  // A live run, or a gone run whose flow run or task still reads some files: keep those.
  if (live || refs.referencedRunIds.has(runId)) {
    return { removed: 0, removedFiles: await sweepUnreferencedFiles(full, runId, refs.referenced) };
  }
  try {
    await rm(full, { recursive: true, force: true });
    return { removed: 1, removedFiles: 0 };
  } catch (err) {
    log.warn('[FlowsAttachments] sweep rm failed', { runId, err });
    return none;
  }
}

/** Must finish before uploads can arrive: an in-flight upload's file is not referenced yet. */
export async function sweepOrphanedAttachments({
  db = getDatabase(),
  root = attachmentsRoot(),
}: { db?: Db; root?: string } = {}): Promise<{
  scanned: number;
  removed: number;
  removedFiles: number;
}> {
  if (!existsSync(root)) return { scanned: 0, removed: 0, removedFiles: 0 };

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    log.warn('[FlowsAttachments] sweep readdir failed', { root, err });
    return { scanned: 0, removed: 0, removedFiles: 0 };
  }

  if (entries.length === 0) return { scanned: 0, removed: 0, removedFiles: 0 };

  const refs = await loadSweepRefs(db, entries);
  let removed = 0;
  let removedFiles = 0;
  for (const runId of entries) {
    const result = await sweepEntry(root, runId, refs);
    removed += result.removed;
    removedFiles += result.removedFiles;
  }

  if (removed > 0 || removedFiles > 0) {
    log.info('[FlowsAttachments] sweep removed orphans', {
      scanned: entries.length,
      removed,
      removedFiles,
    });
  }
  return { scanned: entries.length, removed, removedFiles };
}
