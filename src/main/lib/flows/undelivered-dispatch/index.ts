// sc-2775 watchdog: a flow prompt that never started a turn (lost anywhere between task:chat-ready
// and admission) is re-sent once, then its task fails so the node and run fail visibly.

import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import log from 'electron-log';
import type { getDatabase } from '../../db';
import {
  clearDispatchRedeliveredMarker,
  nextDispatchStamp,
  setDispatchRedeliveredMarker,
  undeliveredDispatchSince,
} from '../../db/repos/task-parking/dispatch-marker';
import { parseResultRecord } from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import { tasks } from '../../db/schema';
import { captureMainMessage } from '../../sentry/init';
import { canRedeliver, redeliverTaskDispatch } from '../../task-executor/dispatch-delivery';
import { forgetDispatch } from '../../task-executor/dispatch-registry';

type Db = ReturnType<typeof getDatabase>;

/** Time a dispatch gets to start a turn, measured from the dispatch and again from the redelivery.
 * The sub-chat being busy (a previous step's turn or wake burst) pauses the clock's effect. */
export const DISPATCH_START_DEADLINE_MS = 10 * 60_000;

export const UNDELIVERED_DISPATCH_ERROR = `This flow step's prompt was sent to its chat, but no turn started within ${
  DISPATCH_START_DEADLINE_MS / 60_000
} minutes, even after it was sent again. Retry the step from the Work Queue.`;

function parseStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Sync predicate: a turn on the sub-chat is in flight or its session is busy. */
async function loadBusyCheck(): Promise<(subChatId: string | null) => boolean> {
  const [{ getSession }, { getActiveExecution }] = await Promise.all([
    import('../../socket/claude-session-registry'),
    import('../../socket/streaming/execution-registry'),
  ]);
  return (subChatId) =>
    subChatId !== null && Boolean(getSession(subChatId)?.busy || getActiveExecution(subChatId));
}

/** Fails the task only while it is still the exact undelivered dispatch the sweep observed. The busy
 * re-check and the UPDATE share one synchronous block, so an admission cannot land between them. */
function failUndeliveredDispatch(
  db: Db,
  task: Task,
  dispatchedAtRaw: string,
  isBusy: (subChatId: string | null) => boolean,
  subChatId: string | null,
) {
  if (isBusy(subChatId)) return;
  const row = db
    .update(tasks)
    .set({
      status: 'failed',
      completedAt: new Date(),
      result: drizzleSql`json_set(COALESCE(${tasks.result}, '{}'), '$.error', ${UNDELIVERED_DISPATCH_ERROR})`,
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.dispatchedAt') = ${dispatchedAtRaw}`,
        drizzleSql`json_extract(${tasks.result}, '$.dispatchStartedAt') IS NULL`,
        drizzleSql`json_extract(${tasks.result}, '$.agentSignal') IS NULL`,
      ),
    )
    .returning({ id: tasks.id })
    .get();
  if (!row) return;
  if (subChatId) forgetDispatch(subChatId, task.id);
  log.warn('[FlowsWatcher] failed a flow step whose prompt never started a turn', {
    taskId: task.id,
    flowRunId: task.flowRunId,
  });
  captureMainMessage('Flow dispatch never started a turn', 'warning', {
    surface: 'flow-task-completion-watcher',
    stage: 'dispatch-never-started-failed',
  });
}

type DueDispatch = { dispatchedAtRaw: string; redelivered: boolean; subChatId: string | null };

/** The task's undelivered dispatch when its deadline has passed; null for non-flow tasks, delivered
 * dispatches, unstamped rows, and any evidence of a turn (a signal, or a quiet end since dispatch). */
function dueUndeliveredDispatch(task: Task, now: number): DueDispatch | null {
  if (!task.flowRunId) return null;
  const result = parseResultRecord(task.result);
  const dispatchedAt = undeliveredDispatchSince(result);
  if (dispatchedAt === null || result.agentSignal) return null;
  if ((parseStamp(result.quietEndedAt) ?? -1) >= dispatchedAt) return null;
  const redeliveredAt = parseStamp(result.dispatchRedeliveredAt);
  if (now - (redeliveredAt ?? dispatchedAt) < DISPATCH_START_DEADLINE_MS) return null;
  const subChatId = typeof result.subChatId === 'string' ? result.subChatId : null;
  return {
    dispatchedAtRaw: String(result.dispatchedAt),
    redelivered: redeliveredAt !== null,
    subChatId,
  };
}

/** First expiry: re-send once (stamp first — a dispatch that moved on since the snapshot is left
 * alone). True when this step is settled for now; false when the task should be failed. */
async function redeliverOnce(db: Db, taskId: string, dispatchedAtRaw: string): Promise<boolean> {
  if (!canRedeliver(taskId)) return true;
  const at = nextDispatchStamp();
  if (!(await setDispatchRedeliveredMarker(db, taskId, dispatchedAtRaw, at))) return true;
  if (!redeliverTaskDispatch(taskId, dispatchedAtRaw)) {
    // The window closed mid-write: give the one retry back and wait. Nothing held: fail.
    if (canRedeliver(taskId)) return false;
    await clearDispatchRedeliveredMarker(db, taskId, at);
    return true;
  }
  captureMainMessage('Flow dispatch redelivered', 'warning', {
    surface: 'flow-task-completion-watcher',
    stage: 'dispatch-redelivered',
  });
  return true;
}

/** One sweep step for a `running` task: redeliver once, then fail (see the module comment). */
export async function recoverUndeliveredDispatch(db: Db, task: Task, now: number): Promise<void> {
  const due = dueUndeliveredDispatch(task, now);
  if (!due) return;
  const isBusy = await loadBusyCheck();
  if (isBusy(due.subChatId)) return;
  if (!due.redelivered && (await redeliverOnce(db, task.id, due.dispatchedAtRaw))) return;
  failUndeliveredDispatch(db, task, due.dispatchedAtRaw, isBusy, due.subChatId);
}
