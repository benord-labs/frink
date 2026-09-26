import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { LSP_CHANNELS } from '../../../shared/lsp-channels';
import { languageServerManager } from './manager';
import type { LanguageId, ServerMessageParams } from './types';

let lspIpcRegistered = false;

/**
 * Setup IPC handlers for language server communication
 */
export function setupLanguageServerIPC(getWindow: () => BrowserWindow | null): void {
  if (lspIpcRegistered) return;
  lspIpcRegistered = true;

  // Start a language server
  ipcMain.handle(
    LSP_CHANNELS.START_SERVER,
    async (
      _event,
      params: { workspacePath: string; language: LanguageId },
    ): Promise<{ success: boolean; pid?: number; error?: string }> => {
      try {
        const instance = await languageServerManager.start(params);

        if (!instance) {
          return { success: false, error: 'Failed to start language server' };
        }

        // Set up forwarding of server messages to renderer
        const key = `${params.workspacePath}:${params.language}`;

        languageServerManager.on(`message:${key}`, (message: unknown) => {
          const window = getWindow();
          window?.webContents.send(LSP_CHANNELS.SERVER_MESSAGE, {
            workspacePath: params.workspacePath,
            language: params.language,
            message, // LSP message object (parsed JSON-RPC)
          });
        });

        languageServerManager.on(`error:${key}`, (error: string) => {
          const window = getWindow();
          window?.webContents.send(LSP_CHANNELS.SERVER_ERROR, {
            workspacePath: params.workspacePath,
            language: params.language,
            error,
          });
        });

        languageServerManager.on(`exit:${key}`, (code: number | null) => {
          const window = getWindow();
          window?.webContents.send(LSP_CHANNELS.SERVER_EXIT, {
            workspacePath: params.workspacePath,
            language: params.language,
            code,
          });
        });

        return { success: true, pid: instance.pid };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // Stop a language server
  ipcMain.handle(
    LSP_CHANNELS.STOP_SERVER,
    async (
      _event,
      params: { workspacePath: string; language: LanguageId },
    ): Promise<{ success: boolean }> => {
      try {
        const success = languageServerManager.stop(params);
        return { success };
      } catch (_error) {
        return { success: false };
      }
    },
  );

  // Send message to language server
  ipcMain.handle(
    LSP_CHANNELS.SEND_MESSAGE,
    async (_event, params: ServerMessageParams): Promise<{ success: boolean }> => {
      try {
        const success = languageServerManager.send(params);
        return { success };
      } catch (_error) {
        return { success: false };
      }
    },
  );

  // Check if server is running
  ipcMain.handle(
    LSP_CHANNELS.IS_RUNNING,
    async (_event, params: { workspacePath: string; language: LanguageId }): Promise<boolean> => {
      return languageServerManager.isRunning(params.workspacePath, params.language);
    },
  );

  // Check if server is available
  ipcMain.handle(
    LSP_CHANNELS.IS_AVAILABLE,
    async (_event, params: { language: LanguageId }): Promise<boolean> => {
      return languageServerManager.isServerAvailable(params.language);
    },
  );
}

/**
 * Cleanup all language servers on app quit
 */
export function cleanupLanguageServers(): void {
  languageServerManager.stopAll();
}
