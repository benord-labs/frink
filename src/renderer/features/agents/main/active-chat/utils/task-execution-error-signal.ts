import { appStore } from '../../../../../lib/jotai-store';
import { type TaskExecutionErrorSignal, taskExecutionErrorAtomFamily } from '../../../atoms';

export function createTaskExecutionErrorSignal(
  error: string,
  category = 'UNKNOWN',
): TaskExecutionErrorSignal {
  return {
    error,
    category,
    timestamp: Date.now(),
  };
}

const FLOW_RUN_DECLINE_CATEGORIES = new Set(['FLOW_RUN_ENDED', 'FLOW_RUN_RESUMING']);

/**
 * Clears a latched flow-run decline signal (FLOW_RUN_ENDED / FLOW_RUN_RESUMING) — and ONLY those
 * categories. An unrelated latched failure (e.g. NETWORK_ERROR from a concurrent send on the same
 * sub-chat) must survive recovery actions, because useTaskCompletionDetection reads this atom to
 * decide whether to fail the task; clearing it blindly would suppress a real task failure. Callers
 * are the deliberate recovery surfaces (new manual send, InterruptedRunControls) — never ambient
 * stream chunks.
 */
export function clearFlowRunEndedErrorSignal(subChatId: string): void {
  const latched = appStore.get(taskExecutionErrorAtomFamily(subChatId));
  if (latched && FLOW_RUN_DECLINE_CATEGORIES.has(latched.category)) {
    appStore.set(taskExecutionErrorAtomFamily(subChatId), null);
  }
}
