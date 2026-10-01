// Cancel bridge (sc-3263): `tasks.cancel` flips the row; this stops the executor turn (keyed by
// sub-chat, same abort as chat archive/delete). A flow row's run is cancelled by cancelWorkQueueTask.

import log from 'electron-log';
import type { Task } from '../db/schema';
import { abortActiveExecutionsForSubChats } from '../socket/executor';
import { getDispatchedSubChatForTask } from '../task-executor/dispatch-registry';

function stampedSubChatId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { subChatId?: unknown }).subChatId;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/** `result`/`triggerContext.subChatId` plus the sub-chat the executor dispatched into (covers a
 * failed stamp). None means the claim never dispatched: its pre-dispatch status check stops it. */
export function resolveTaskSubChatIds(task: Task): string[] {
  const ids = [
    stampedSubChatId(task.result),
    stampedSubChatId(task.triggerContext),
    getDispatchedSubChatForTask(task.id),
  ];
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** `task` is the row the cancel replaced (`cancelTaskDetailed`'s `previous`). Only a `running`
 * task is stopped (the user may drive a plan_ready chat); never throws, the cancel is saved. */
export function stopTaskSession(task: Task): void {
  if (task.status !== 'running') return;

  try {
    const subChatIds = resolveTaskSubChatIds(task);
    if (subChatIds.length > 0) abortActiveExecutionsForSubChats(subChatIds, 'task cancelled');
  } catch (error) {
    log.warn('[tasks.cancel] Failed to abort the cancelled task session', {
      taskId: task.id,
      error,
    });
  }
}
