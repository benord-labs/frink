// sc-3263: a task-dispatched turn registers its execution after renderer IPC, so a Cancel landing
// first has no session to abort. Re-check once registered; any later Cancel finds the execution.

import log from 'electron-log';
import { getDatabase } from '../db';
import { getTaskById } from '../db/repos/tasks';
import { getActiveExecution } from '../socket/streaming/execution-registry';
import { getDispatchedSubChatForTask } from '../task-executor/dispatch-registry';

export async function abortIfTaskNoLongerRunning(taskId: string, subChatId: string): Promise<void> {
  // A send's claimed ids are untrusted: act only on the executor's own task→sub-chat binding.
  if (getDispatchedSubChatForTask(taskId) !== subChatId) return;
  // Pin the execution just registered: a retry may replace it on this sub-chat while we await.
  const epoch = getActiveExecution(subChatId)?.streamEpoch;
  if (!epoch) return;
  try {
    if ((await getTaskById(getDatabase(), taskId))?.status === 'running') return;
    // Dynamic import: socket/client ← this module ← executor would otherwise be a static cycle.
    const { abortActiveExecutionsForSubChats } = await import('../socket/executor');
    if (getActiveExecution(subChatId)?.streamEpoch !== epoch) return;
    abortActiveExecutionsForSubChats([subChatId], 'task cancelled');
  } catch (error) {
    log.warn('[tasks.cancel] Dispatch fence check failed', { taskId, subChatId, error });
  }
}
