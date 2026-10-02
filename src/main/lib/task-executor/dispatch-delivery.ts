/**
 * Flow dispatch delivery (sc-2775): the claim-time delivery stamps, the `task:chat-ready` broadcast,
 * and the watchdog's one redelivery of a dispatch whose prompt never started a turn.
 */

import { eq } from 'drizzle-orm';
import { BrowserWindow } from 'electron';
import log from 'electron-log';
import type { TaskChatReadyData } from '../../../shared/types/task-chat-ready';
import { isDispatchStarted, nextDispatchStamp } from '../db/repos/task-parking/dispatch-marker';
import { parseResultRecord } from '../db/repos/tasks';
import { getDatabase } from '../db';
import type { Task as DbTask } from '../db/schema';
import { tasks } from '../db/schema';
import {
  getRedeliverableDispatch,
  isDispatchSendInFlight,
  isTaskBeingDelivered,
  registerPendingDispatchMode,
} from './dispatch-registry';

/** Claim stamps (flow tasks only): a heartbeat re-claim of a started task stays delivered (the
 * renderer swallows the re-sent prompt); a user retry re-sends it, so it starts undelivered. */
export function flowDispatchStamps(
  task: DbTask,
  retryMode: 'continue' | 'restart' | null,
  subChatId: string,
): { dispatchedAt: string; dispatchStartedAt?: string } | undefined {
  if (!task.flowRunId) return undefined;
  const dispatchedAt = nextDispatchStamp();
  // Read the row now, not the claim snapshot (a start can land during chat setup); a turn of THIS
  // task mid-stamp counts too.
  const current = getDatabase()
    .select({ result: tasks.result })
    .from(tasks)
    .where(eq(tasks.id, task.id))
    .get();
  const started =
    isDispatchStarted(current?.result ?? task.result) || isTaskBeingDelivered(task.id, subChatId);
  return !retryMode && started
    ? { dispatchedAt, dispatchStartedAt: dispatchedAt }
    : { dispatchedAt };
}

/** An unstamped flow dispatch is unrecoverable (sc-2775): fail it through the dispatch path, keeping
 * the chat just created so the requeued claim reuses it instead of orphaning it. */
export function failUnstampedFlowClaim(
  task: DbTask,
  chat: { chatId: string; subChatId: string },
  error: unknown,
): void {
  if (!task.flowRunId) return;
  task.result = { ...parseResultRecord(task.result), ...chat };
  throw error;
}

/** Send to all windows (in case app has multiple) — a flow dispatch to one. */
export function broadcastTaskChatReady(payload: TaskChatReadyData): void {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  // A headless flow dispatch goes to ONE window: every window would queue it, and the second send
  // would replace the delivering turn (sc-2775). A window that missed it pulls it on mount.
  for (const win of payload.headless ? windows.slice(0, 1) : windows) {
    win.webContents.send('task:chat-ready', payload);
  }
}

/** Whether a renderer exists to redeliver to — without one the watchdog waits rather than fails. */
export function canRedeliver(taskId: string): boolean {
  if (isDispatchSendInFlight(taskId)) return false;
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
}

/** Re-sends the held dispatch (also re-armed for the renderer's pull); its sent/queued dedup still
 * applies. False when none is held (restart, evicted). */
export function redeliverTaskDispatch(taskId: string, generation: string): boolean {
  const held = getRedeliverableDispatch(taskId);
  // Only the attempt the watchdog stamped: a retry registered since is its own, live dispatch.
  if (held?.payload.dispatchGeneration !== generation) return false;
  // One window only: every renderer would enqueue it, and a prompt not yet in the chat is not deduped.
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!held || !win) return false;
  // Never as a retry: `isRetry` bypasses the renderer's sent-dedup, so a prompt that was in fact
  // sent (its admission merely slow) would run twice. A swallowed redelivery fails visibly instead.
  const { isRetry: _isRetry, ...payload } = held.payload;
  registerPendingDispatchMode(payload.subChatId, taskId, held.startMode, payload);
  log.warn('[TaskExecutor] redelivering a flow dispatch that never started a turn', {
    taskId,
    subChatId: payload.subChatId,
  });
  win.webContents.send('task:chat-ready', payload);
  return true;
}
