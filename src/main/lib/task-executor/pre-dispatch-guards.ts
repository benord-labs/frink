/** Checks a claimed task passes after its chat is prepared and before its turn is dispatched. */
import log from 'electron-log';
import { getDatabase } from '../db';
import { isChatArchived } from '../db/repos/task-queries/chat-archive-tasks';
import { cancelTaskDetailed } from '../db/repos/tasks';
import type { Task as DbTask } from '../db/schema';

/**
 * Un-fail a retried flow task's node_run/flow_run so the watcher accepts the agent's next `done`
 * (a terminal run would discard it). Non-batch only — resumeFailedFlowInPlace refuses batch runs
 * whose stage-run wasn't pre-opened, deliberately-cancelled runs (no restart marker), fan-out
 * lanes. Returns whether the run is now accepting the agent's `done`: on `false` the caller must
 * NOT dispatch — the turn would stream into a terminal run and stall silently. Never throws.
 */
export async function unparkRetriedFlowRun(taskId: string, flowRunId: string): Promise<boolean> {
  try {
    const { resumeFailedFlowInPlace } = await import('../flows/resume');
    const resumed = await resumeFailedFlowInPlace(flowRunId, taskId);
    if (!resumed) {
      log.warn('[TaskExecutor] resumeFailedFlowInPlace did not unpark the flow run', {
        taskId,
        flowRunId,
      });
    }
    return resumed;
  } catch (error) {
    log.warn('[TaskExecutor] resumeFailedFlowInPlace failed', {
      taskId,
      flowRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** A parked task retried after its chat was archived is cancelled, not dispatched into that chat. */
export async function cancelIfChatArchived(task: DbTask, chatId: string): Promise<boolean> {
  if (task.flowRunId) return false;
  const db = getDatabase();
  let archived: boolean;
  try {
    archived = isChatArchived(db, chatId);
  } catch (error) {
    // Admission re-reads the row and fails closed, so an unreadable one still never runs.
    log.warn('[TaskExecutor] Could not read whether the chat is archived', { chatId, error });
    return false;
  }
  if (!archived) return false;
  cancelTaskDetailed(db, task.id);
  log.info('[TaskExecutor] Linked chat is archived; task cancelled, not dispatching', {
    taskId: task.id,
    chatId,
  });
  return true;
}
