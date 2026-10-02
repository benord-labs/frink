// How a failed turn reaches the user: the per-sub-chat error signal, its toast, and the rollback /
// Retry follow-ups. Split from websocket-chat-transport.ts, which owns the stream itself.
import { toast } from 'sonner';
import {
  ERROR_TOAST_CONFIG,
  shouldPersistChatRetry,
  toastDedupId,
} from '../../../../lib/agent-chat/errors/error-toast-config';
import { appStore } from '../../../../lib/jotai-store';
import { taskExecutionErrorAtomFamily } from '../../atoms';
import {
  createTaskExecutionErrorSignal,
  isExecutionLevelFailure,
} from '../../main/active-chat/utils';

export function shouldRollbackExecutionError(rawError: string, category: string): boolean {
  return isExecutionLevelFailure(rawError, category);
}

/** Roll back only execution-level failures; offer Retry only for retryable categories. The retry
 * write goes last — it is localStorage-backed and can throw (quota). */
export function dispatchFailureFollowups(
  errorText: string,
  category: string,
  rollback: () => void,
  persistRetry: (errorCategory: string, rawErrorText: string) => void,
): void {
  if (shouldRollbackExecutionError(errorText, category)) {
    rollback();
  }
  if (shouldPersistChatRetry(category)) {
    persistRetry(category, errorText);
  }
}

/** Latch the per-sub-chat error signal and show the category's toast (or the generic one). */
export function surfaceExecutionError(
  subChatId: string,
  errorText: string,
  category: string | undefined,
): void {
  appStore.set(
    taskExecutionErrorAtomFamily(subChatId),
    createTaskExecutionErrorSignal(errorText, category),
  );
  const toastConfig = ERROR_TOAST_CONFIG[category ?? 'UNKNOWN'];
  toast.error(toastConfig?.title ?? 'Execution failed', {
    description: toastConfig?.description || errorText || 'Unknown error',
    action: toastConfig?.action,
    ...toastDedupId(toastConfig, subChatId),
  });
}
