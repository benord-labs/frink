import log from 'electron-log';
import type { SocketPermissionProjection } from '../../../../../shared/types/permissions';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../../../permissions/constants';

export type PermissionResponse = {
  chatId: string;
  subChatId: string;
  requestId: string;
  approved: boolean;
  timedOut?: boolean;
  scope?: 'project' | 'user';
  ruleString?: string;
  ruleType?: 'allow' | 'deny' | 'ask';
  /** The flow-consent card's "Always allow this flow" answer. */
  flowGrant?: boolean;
};

type PendingPermission = {
  subChatId: string;
  payload: SocketPermissionProjection;
  settle: (response: PermissionResponse, dismiss: boolean) => void;
};

/** One process runs one broker (validate-tool-permission.ts); shared here so `list` can read it. */
const pendingPermissionRequests = new Map<string, PendingPermission>();

/** Renderer-safe recovery view of every outstanding file/bash/mcp_tool permission wait. */
export function listPendingPermissionRequests(): SocketPermissionProjection[] {
  return [...pendingPermissionRequests.values()].map((pending) => pending.payload);
}

export function generatePermissionRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Build the permission wait without importing the socket client back through executor.ts. */
export function createPendingPermissionRequestBroker(input: {
  getExecutionSignal: (subChatId: string) => AbortSignal | undefined;
  onResponse: (callback: (response: PermissionResponse) => void) => void;
  sendDismiss: (payload: { requestId: string; chatId: string; subChatId: string }) => void;
  sendRequest: (payload: SocketPermissionProjection) => void;
}) {
  const hasPending = (subChatId: string): boolean => {
    for (const pending of pendingPermissionRequests.values()) {
      if (pending.subChatId === subChatId) return true;
    }
    return false;
  };

  const request = (
    payload: SocketPermissionProjection,
    /**
     * The turn whose abort dismisses this card. Omit to bind to whatever
     * execution owns the sub-chat; pass `null` to bind to NOTHING — for a card
     * that must outlive the turn that raised it.
     */
    executionSignal?: AbortSignal | null,
    timeoutMs = PERMISSION_PROMPT_TIMEOUT_MS,
  ): Promise<PermissionResponse> =>
    new Promise((resolve) => {
      const { requestId } = payload;
      const signal =
        executionSignal === null
          ? undefined
          : (executionSignal ?? input.getExecutionSignal(payload.subChatId));
      let settled = false;
      let detachAbort = () => {};
      let timeout: ReturnType<typeof setTimeout>;

      const settle = (response: PermissionResponse, dismiss: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        detachAbort();
        pendingPermissionRequests.delete(requestId);
        if (dismiss) {
          input.sendDismiss({
            requestId,
            chatId: payload.chatId,
            subChatId: payload.subChatId,
          });
        }
        resolve(response);
      };

      timeout = setTimeout(() => {
        log.warn(
          `[Permission] Remote permission timed out after ${timeoutMs / 1000}s (${requestId})`,
        );
        settle(
          {
            chatId: payload.chatId,
            subChatId: payload.subChatId,
            requestId,
            approved: false,
            timedOut: true,
          },
          true,
        );
      }, timeoutMs);

      const abort = () =>
        settle(
          {
            chatId: payload.chatId,
            subChatId: payload.subChatId,
            requestId,
            approved: false,
            timedOut: true,
          },
          true,
        );
      pendingPermissionRequests.set(requestId, { subChatId: payload.subChatId, payload, settle });
      if (signal) {
        detachAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }

      if (!settled) input.sendRequest(payload);
    });

  const drain = (): void => {
    if (pendingPermissionRequests.size === 0) return;
    log.warn(
      `[Permission] Draining ${pendingPermissionRequests.size} pending permission(s) on disconnect`,
    );
    for (const [requestId, pending] of [...pendingPermissionRequests]) {
      pending.settle(
        {
          chatId: '',
          subChatId: pending.subChatId,
          requestId,
          approved: false,
          timedOut: true,
        },
        true,
      );
    }
  };

  // Dismiss on every answer: the answering window pops its own card, but the phone and
  // other windows only learn the request is gone from this broadcast.
  input.onResponse((response) => {
    pendingPermissionRequests.get(response.requestId)?.settle(response, true);
  });

  return { drain, hasPending, request };
}
