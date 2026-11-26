import log from 'electron-log';
import { clearPendingApprovals } from '../../../claude/ask-user-question-approval';
import { retireRetainedSession } from '../../claude-session-registry';
import { hasWakeHold, releaseWakeHold } from '../../claude-wake-hold';
import {
  deleteActiveExecution,
  getActiveExecution,
  hasActiveExecutions,
  listExecutionsForWebContents,
  listSubChatIdsForChat,
} from '../../streaming/execution-registry';
import * as flow from '../flow-resource-cleanup';
import { listWakeHoldSubChatIdsForChat } from '../wake-hold-registry-view';

/** Why each sub-chat's execution was aborted, stamped before the abort so the executor can classify it. */
export const executionAbortSources = new Map<string, string>();

/** User pause: callers park first, and this abort skips flow teardown so the park survives. A
 * between-turn wake hold counts as an active execution. */
export function pauseActiveExecutionForSubChat(subChatId: string): boolean {
  const hadHold = hasWakeHold(subChatId);
  releaseWakeHold(subChatId, 'user-pause');
  const record = getActiveExecution(subChatId);
  if (!record) return hadHold;
  clearPendingApprovals('Paused by user.', subChatId);
  // Stamp before aborting, like every other stop path — unstamped, this pause is classified off
  // the SDK's error text alone, and a bare AbortError parks it as an api-error.
  executionAbortSources.set(subChatId, 'user-pause');
  record.controller.abort();
  deleteActiveExecution(subChatId);
  return true;
}

/** A Stop for the chat: ends its run and any between-turn wake hold. */
export function handleRemoteStop(payload: { chatId: string; subChatId: string }): void {
  const record = getActiveExecution(payload.subChatId);
  const persistence = record
    ? flow.startFlowTaskTeardown(payload.subChatId, false, record.controller)
    : undefined;
  releaseWakeHold(payload.subChatId, 'remote-stop', persistence);
  if (record) {
    executionAbortSources.set(payload.subChatId, 'remote-stop');
    log.info(`[Socket Executor] Stopping execution for ${payload.subChatId}`);
    clearPendingApprovals('Session cancelled.', payload.subChatId);
    record.controller.abort();
    deleteActiveExecution(payload.subChatId);
  }
}

/** A chat's sub-chats with a live turn or wake hold, read from memory so abort survives a DB failure. */
export function collectLiveSubChatIdsForChat(
  chatId: string,
  listWakeHolds: (chatId: string) => string[] = listWakeHoldSubChatIdsForChat,
): string[] {
  return [...new Set([...listSubChatIdsForChat(chatId), ...listWakeHolds(chatId)])];
}

/** Delete and archive call this before flipping the row, so no agent keeps working in a worktree
 * that is about to be removed. */
export function abortActiveExecutionsForSubChats(
  subChatIds: readonly string[],
  reason: string,
): void {
  for (const subChatId of subChatIds) {
    releaseWakeHold(subChatId, reason);
    retireRetainedSession(subChatId, reason);
  }
  if (!hasActiveExecutions() || subChatIds.length === 0) return;
  let aborted = 0;
  for (const subChatId of subChatIds) {
    const record = getActiveExecution(subChatId);
    if (!record) continue;
    executionAbortSources.set(subChatId, reason);
    clearPendingApprovals(`Session aborted: ${reason}.`, subChatId);
    record.controller.abort();
    deleteActiveExecution(subChatId);
    aborted += 1;
  }
  if (aborted > 0) {
    log.info(`[Socket Executor] Aborted ${aborted} execution(s) for sub-chats: ${reason}`);
  }
}

/** Abort the runs a BrowserWindow owns; runs with no local renderer (a phone's) keep going. */
export function abortActiveExecutionsForWebContents(webContentsId: number, reason: string): void {
  const toAbort = listExecutionsForWebContents(webContentsId);
  if (toAbort.length === 0) return;
  log.info(
    `[Socket Executor] Aborting ${toAbort.length} active execution(s) for webContents ${webContentsId}: ${reason}`,
  );
  for (const [subChatId, record] of toAbort) {
    const persistence = flow.startFlowTaskTeardown(subChatId, true, record.controller);
    releaseWakeHold(subChatId, `renderer-lifecycle:${reason}`, persistence);
    executionAbortSources.set(subChatId, reason);
    clearPendingApprovals(`Session aborted: ${reason}.`, subChatId);
    record.controller.abort();
    deleteActiveExecution(subChatId);
  }
}
