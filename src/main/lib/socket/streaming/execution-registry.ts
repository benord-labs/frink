import { randomUUID } from 'node:crypto';
import {
  registerActiveExecutionCountReader,
  registerOwnerlessExecutionCountReader,
} from '../../diagnostics/provider-topology';

/**
 * Live execution records, keyed by sub-chat: the abort controller every stop path reaches for,
 * plus which local window "owns" the run — the window whose execute request started it and whose
 * transport rebuilds the assistant message from stream deltas. Local IPC is delta-only for every
 * window; mutable ownership only suppresses duplicate observer painting while that transport is
 * alive. Main retains a bounded latest-state seed for a replacement renderer.
 *
 * Lives outside executor.ts so the send path (client.ts) can read ownership without a
 * client → executor import cycle. A dev full reload releases ownership without aborting: the
 * reloaded window keeps its webContents.id but loses its transports, so its surviving runs fall
 * back to the observer reducer after a bounded seed.
 */

export type ActiveExecutionRecord = {
  controller: AbortController;
  /** Immutable lifecycle affinity: window close/recovery failure must still find this run. */
  rendererAffinityWebContentsId?: number;
  /** Mutable delivery owner. Cleared when a renderer loses its in-memory transport. */
  localRendererWebContentsId?: number;
  /** Main-minted identity; presentation ids and numeric cursors are intentionally reusable. */
  streamEpoch: string;
  chatId?: string;
  assistantMessageId?: string;
};

type ExecutionPresentation = { chatId: string; assistantMessageId: string };

const activeExecutions = new Map<string, ActiveExecutionRecord>();
registerActiveExecutionCountReader(() => activeExecutions.size);
// A run nobody owns has no live delta transport: every window, the focused one included, paints it
// through the observer reducer after a bounded seed — coarser by design, and otherwise
// indistinguishable in a bug report from a main-thread stall.
registerOwnerlessExecutionCountReader(
  () =>
    [...activeExecutions.values()].filter(
      (record) => record.localRendererWebContentsId === undefined,
    ).length,
);

export function setActiveExecution(
  subChatId: string,
  controller: AbortController,
  localRendererWebContentsId?: number,
  presentation?: ExecutionPresentation,
): void {
  activeExecutions.set(subChatId, {
    controller,
    rendererAffinityWebContentsId: localRendererWebContentsId,
    localRendererWebContentsId,
    streamEpoch: randomUUID(),
    ...presentation,
  });
}

/** Swap the provider controller without rotating the run epoch or losing presentation metadata. */
export function replaceActiveExecutionController(
  subChatId: string,
  controller: AbortController,
): void {
  const record = activeExecutions.get(subChatId);
  if (!record) return;
  activeExecutions.set(subChatId, { ...record, controller });
}

export function getActiveExecution(subChatId: string): ActiveExecutionRecord | undefined {
  return activeExecutions.get(subChatId);
}

export function deleteActiveExecution(subChatId: string): void {
  activeExecutions.delete(subChatId);
}

export function hasActiveExecutions(): boolean {
  return activeExecutions.size > 0;
}

export function listExecutionsForWebContents(
  webContentsId: number,
): Array<[string, ActiveExecutionRecord]> {
  return [...activeExecutions.entries()].filter(
    ([, record]) => record.rendererAffinityWebContentsId === webContentsId,
  );
}

export function getExecutionOwner(subChatId: string): number | undefined {
  return activeExecutions.get(subChatId)?.localRendererWebContentsId;
}

export function getExecutionStreamEpoch(
  subChatId: string,
  assistantMessageId?: string,
): string | undefined {
  const record = activeExecutions.get(subChatId);
  if (!record) return undefined;
  if (
    assistantMessageId &&
    record.assistantMessageId &&
    record.assistantMessageId !== assistantMessageId
  ) {
    return undefined;
  }
  return record.streamEpoch;
}

export function listActiveExecutionHeaders(): Array<{
  subChatId: string;
  chatId?: string;
  assistantMessageId?: string;
  streamEpoch: string;
}> {
  return [...activeExecutions].map(([subChatId, record]) => ({
    subChatId,
    chatId: record.chatId,
    assistantMessageId: record.assistantMessageId,
    streamEpoch: record.streamEpoch,
  }));
}

/** Sub-chats with a live run for `chatId`, read from the registry alone (no DB round-trip). */
export function listSubChatIdsForChat(chatId: string): string[] {
  const subChatIds: string[] = [];
  for (const [subChatId, record] of activeExecutions) {
    if (record.chatId === chatId) subChatIds.push(subChatId);
  }
  return subChatIds;
}

/** A send between its chat-row read and registration. Archive dooms these once archived_at lands, so
 * one that read the pre-archive row still declines. Held only for the admission, so bounded. */
export type AdmissionToken = { chatId: string; doomed: boolean };
const admissions = new Set<AdmissionToken>();

export function openAdmission(chatId: string): AdmissionToken {
  const token = { chatId, doomed: false };
  admissions.add(token);
  return token;
}

export function closeAdmission(token: AdmissionToken): void {
  admissions.delete(token);
}

export function doomAdmissionsForChat(chatId: string): void {
  for (const token of admissions) if (token.chatId === chatId) token.doomed = true;
}

/** Why a send must not start: its chat row was unreadable (retryable), or the chat is archived. */
export function admissionDeclineError(
  chatReadFailed: boolean,
  token: AdmissionToken | null,
  archivedAt: unknown,
): (Error & { category?: string }) | null {
  if (chatReadFailed) return new Error('Could not read this chat. Try again.');
  if (!token?.doomed && !archivedAt) return null;
  const error = new Error('This chat is archived. Restore it to continue.');
  return Object.assign(error, { category: 'CHAT_ARCHIVED' });
}

/** A window navigated away from its document (dev full reload): its transports are gone. */
export function releaseExecutionOwnershipForWebContents(webContentsId: number): void {
  for (const record of activeExecutions.values()) {
    if (record.localRendererWebContentsId === webContentsId) {
      record.localRendererWebContentsId = undefined;
    }
  }
}

/** Test-only: seed an AbortController so abort-path tests can inspect behavior. */
export function _registerExecutionForTests(
  subChatId: string,
  controller: AbortController,
  localRendererWebContentsId?: number,
  chatId?: string,
): void {
  setActiveExecution(
    subChatId,
    controller,
    localRendererWebContentsId,
    chatId ? { chatId, assistantMessageId: `test-${subChatId}` } : undefined,
  );
}

/** Test-only: probe the activeExecutions map. */
export function _hasActiveExecutionForTests(subChatId: string): boolean {
  return activeExecutions.has(subChatId);
}

/** Test-only: read current map size. */
export function _getActiveExecutionCountForTests(): number {
  return activeExecutions.size;
}

/** Test-only: clear any seeded entries between tests. */
export function _clearActiveExecutionsForTests(): void {
  activeExecutions.clear();
  admissions.clear();
}
