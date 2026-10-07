/** Stops ONE background task of a held chat and re-publishes the rest at once (a stopped shell or
 * workflow runs no turn to refresh the list). The last item is refused: Stop ends the wait. */

import type { BackgroundTaskSummary } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { withTimeout } from '../../../agent-runner/process-settlement';
import { forgetPendingTask, type StopPendingWork } from '../../../task-stop-hook';
import type { ClaudeSession } from '../../claude-session-registry';
import { readWakeHolds, type WakeHold } from '../../claude-wake-hold';
import { STOPPABLE_TASK_TYPES, summarizePendingWork } from '../wake-hold-signal';

const STOP_TIMEOUT_MS = 10_000;

export type StopBackgroundTaskResult =
  | { ok: true }
  /** 'ended': the wait or the task is already gone. 'last': nothing else would be left waiting. */
  | { ok: false; reason: 'ended' | 'last' | 'timeout' }
  | { ok: false; reason: 'failed'; message: string };

/** Stops the CLI has not answered yet, by task id. */
type StopsInFlight = Map<string, Promise<StopBackgroundTaskResult>>;

/** Keyed by session, so it dies with it. */
const stoppingBySession = new WeakMap<ClaudeSession, StopsInFlight>();

/** The chat's hold while its wait is still live and its CLI can still take a control request. */
function liveHold(subChatId: string): WakeHold | null {
  const hold = readWakeHolds().get(subChatId);
  if (!hold || hold.retracted || hold.settling || hold.pump.isEnded()) return null;
  return hold.session.queue.closed ? null : hold;
}

export async function stopBackgroundTask(
  subChatId: string,
  taskId: string,
): Promise<StopBackgroundTaskResult> {
  const hold = liveHold(subChatId);
  const work = hold?.session.stopHook?.lastPendingWork;
  const task = work?.backgroundTasks.find((candidate) => candidate.id === taskId);
  if (!hold || !work || !task || !STOPPABLE_TASK_TYPES.has(task.type)) {
    return { ok: false, reason: 'ended' };
  }
  const stopping: StopsInFlight = stoppingBySession.get(hold.session) ?? new Map();
  stoppingBySession.set(hold.session, stopping);
  // A repeat click (or a second window) joins the stop already in flight rather than racing it.
  const answered = stopping.get(taskId) ?? requestStop(subChatId, hold, task, stopping, work);
  if (!answered) return { ok: false, reason: 'last' };
  return withTimeout(answered, STOP_TIMEOUT_MS, 'stop_task timed out').catch(
    (): StopBackgroundTaskResult => ({ ok: false, reason: 'timeout' }),
  );
}

/** Null when this would leave nothing waiting. Held until the CLI answers, not until we stop
 * waiting: a timed-out stop can still land, so it keeps counting as gone. */
function requestStop(
  subChatId: string,
  hold: WakeHold,
  task: BackgroundTaskSummary,
  stopping: StopsInFlight,
  work: StopPendingWork,
): Promise<StopBackgroundTaskResult> | null {
  const others = work.backgroundTasks.filter((t) => t.id !== task.id && !stopping.has(t.id));
  if (others.length + work.sessionCrons.length === 0) return null;
  const answered = Promise.resolve()
    .then(() => hold.session.query.stopTask(task.id))
    .then(
      (): StopBackgroundTaskResult => {
        log.info(`[Socket] ${subChatId}: user stopped background ${task.type} task ${task.id}`);
        forgetStoppedTask(subChatId, hold, task);
        return { ok: true };
      },
      (error: unknown): StopBackgroundTaskResult => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[Socket] ${subChatId}: stopping background task ${task.id} failed: ${message}`);
        return { ok: false, reason: 'failed', message };
      },
    )
    .finally(() => stopping.delete(task.id));
  stopping.set(task.id, answered);
  return answered;
}

/** Drop the stopped task from the live snapshot and re-publish — unless the wait moved on during
 * the await (taken over, stopped, re-armed), in which case its own publish already stands. */
function forgetStoppedTask(subChatId: string, hold: WakeHold, task: BackgroundTaskSummary): void {
  const stopHook = hold.session.stopHook;
  const latest = stopHook?.lastPendingWork;
  if (liveHold(subChatId) !== hold || !stopHook || !latest) return;
  const next = forgetPendingTask(latest, task.id);
  // It became the last item only because the rest settled meanwhile. A stopped subagent's reaction
  // turn re-reads the list and ends the wait itself; a shell or workflow runs none, so end it here.
  if (!next && task.type === 'subagent') return;
  stopHook.lastPendingWork = next;
  if (next) hold.setHeld(true, summarizePendingWork(next));
  else hold.pump.settleIfWorkFinished();
}
