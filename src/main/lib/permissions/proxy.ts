/**
 * Local-IPC half of the permission prompt: `permission:request` out, the renderer's v2 response
 * back. Reserved for local-only execution; today every execution prompts over the socket instead.
 */

import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import type { PromptData, RuleType } from '../../../shared/types/permissions';
import { PERMISSION_PROMPT_TIMEOUT_MS } from './constants';

// ============================================================================
// Bash Command Prompts
// ============================================================================

type BashCommandPromptRequest = {
  // Field is bash-historical; semantically now "tool input" — for bash it's the command,
  // for file ops it's the path, for MCP it's a stub. Rename deferred to ticket 14.
  command: string;
  /** Omitted when the chat has no project row — the renderer then disables "Allow for project". */
  projectPath?: string;
  reason?: string;
  /** Abort signal to cancel the prompt early (e.g. agent stopped). */
  signal?: AbortSignal;
  /** v2 dispatcher prompt context (ticket 11 step 2). See client.ts for full doc. */
  prompt?: PromptData;
};

type BashCommandPromptResult = {
  approved: boolean;
  /** v2 response fields. Undefined when user clicked "Allow once" (no persistence). */
  scope?: 'project' | 'user';
  ruleString?: string;
  ruleType?: RuleType;
};

/**
 * Prompt user for tool permission (bash, file ops, MCP — historical name).
 *
 * Returns v2 fields based on which button the user clicked:
 * - "Allow once"        → { approved: true, scope: undefined }
 * - "Allow for project" → { approved: true, scope: 'project', ruleString, ruleType: 'allow' }
 * - "Allow on machine"  → { approved: true, scope: 'user', ruleString, ruleType: 'allow' }
 * - "Deny"              → { approved: false }
 *
 * TODO(ticket-14): rename to `promptUserForToolPermission`.
 */
export async function promptUserForBashCommand(
  request: BashCommandPromptRequest,
): Promise<BashCommandPromptResult> {
  const windows = BrowserWindow.getAllWindows();
  const mainWindow = windows.find((w) => !w.isDestroyed());

  if (!mainWindow) {
    return { approved: false };
  }

  return new Promise((resolve) => {
    const requestId = `bash_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let detachAbort: (() => void) | undefined;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      detachAbort?.();
      ipcMain.removeListener('permission:response', handleResponse);
      mainWindow.webContents.removeListener('destroyed', handleWindowDestroyed);
    };

    const handleResponse = (
      _event: Electron.IpcMainEvent,
      response: {
        requestId: string;
        approved: boolean;
        scope?: 'project' | 'user';
        ruleString?: string;
        ruleType?: RuleType;
      },
    ) => {
      if (response.requestId !== requestId) return;
      cleanup();
      resolve({
        approved: response.approved,
        scope: response.scope,
        ruleString: response.ruleString,
        ruleType: response.ruleType,
      });
    };

    const handleWindowDestroyed = () => {
      cleanup();
      resolve({ approved: false });
    };

    ipcMain.on('permission:response', handleResponse);
    mainWindow.webContents.on('destroyed', handleWindowDestroyed);

    // Bring window to front so the permission prompt (fixed bottom-right) is visible.
    // Otherwise the user never sees it when Frink is in background (e.g. running from Cursor).
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();

    // Send bash-specific request to renderer with pattern choices
    log.info(
      `[Permission] Bash prompt sent via IPC (${requestId}), command: ${request.command.slice(0, 50)}...`,
    );
    mainWindow.webContents.send('permission:request', {
      requestId,
      scope: { type: 'bash' as const },
      path: request.command, // Command is in path field
      operation: 'bash' as const,
      reason: request.reason,
      projectPath: request.projectPath,
      prompt: request.prompt,
    });

    if (request.signal) {
      const onAbort = () => {
        log.info(`[Permission] Bash prompt aborted by caller (${requestId})`);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('permission:dismiss', { requestId });
        }
        cleanup();
        resolve({ approved: false });
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => request.signal?.removeEventListener('abort', onAbort);
    }

    timeoutId = setTimeout(() => {
      log.warn(`[Permission] Bash prompt timed out (${requestId})`);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('permission:dismiss', { requestId });
      }
      cleanup();
      resolve({ approved: false });
    }, PERMISSION_PROMPT_TIMEOUT_MS);
  });
}
