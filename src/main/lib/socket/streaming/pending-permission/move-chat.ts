import { BrowserWindow, ipcMain } from 'electron';
import type { PendingMoveChatProjection } from '../../../../../shared/types/permissions';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../../../permissions/constants';

type MoveChatRequest = Omit<PendingMoveChatProjection, 'operation'>;

const pendingRequests = new Map<
  string,
  {
    subChatId: string;
    projection: PendingMoveChatProjection;
    resolve: (approved: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const pendingBySubChat = new Map<string, string>();
let responseHandlerRegistered = false;

function finishRequest(requestId: string, approved: boolean): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);
  pendingBySubChat.delete(pending.subChatId);
  pending.resolve(approved);
}

/** Renderer-safe recovery view of every outstanding move-chat approval. */
export function listPendingMoveChatRequests(): PendingMoveChatProjection[] {
  return [...pendingRequests.values()].map((pending) => pending.projection);
}

function ensureResponseHandler(): void {
  if (responseHandlerRegistered) return;
  responseHandlerRegistered = true;
  ipcMain.on(
    'agent:move-chat-response',
    (_event: Electron.IpcMainEvent, payload: { requestId: string; approved: boolean }) => {
      finishRequest(payload.requestId, payload.approved);
    },
  );
}

export function hasPendingMoveChatApproval(subChatId: string): boolean {
  return pendingBySubChat.has(subChatId);
}

/** Ask the renderer to approve a move while retaining the prompt across renderer recovery. */
export function requestMoveChatApproval(payload: MoveChatRequest): Promise<boolean> {
  ensureResponseHandler();
  pendingBySubChat.set(payload.subChatId, payload.requestId);
  const projection: PendingMoveChatProjection = { ...payload, operation: 'move_chat' };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      finishRequest(payload.requestId, false);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('permission:dismiss', { requestId: payload.requestId });
        }
      }
    }, PERMISSION_PROMPT_TIMEOUT_MS);
    pendingRequests.set(payload.requestId, {
      subChatId: payload.subChatId,
      projection,
      resolve,
      timeout,
    });

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent:request-move-chat', projection);
    }
  });
}
