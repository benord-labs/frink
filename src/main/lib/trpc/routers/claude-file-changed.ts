import path from 'node:path';
import { BrowserWindow } from 'electron';

/**
 * Tool part types (`tool-${toolName}`) that write to disk via `file_path`.
 * Must stay aligned with Claude Code SDK tool names.
 */
export const WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC = new Set<string>([
  'tool-Write',
  'tool-Edit',
  'tool-MultiEdit',
  'tool-NotebookEdit',
  'tool-Delete',
]);

/**
 * Resolve `file_path` from a Write/Edit/etc. tool to an absolute path for `file-changed` IPC.
 * Relative paths are resolved against the chat cwd so the editor can match open tabs (worktrees).
 */
export function resolveWriteToolFilePathForIpc(
  rawPath: string,
  cwd: string | undefined,
): string | null {
  if (!rawPath) return null;
  if (path.isAbsolute(rawPath)) return rawPath;
  if (!cwd) return null;
  return path.resolve(cwd, rawPath);
}

/**
 * Pure gate for `file-changed` IPC: write-tool type + `file_path` + resolvable path.
 * Keeps Electron out of unit tests; main process calls this then broadcasts.
 */
export function tryBuildWriteToolFileChangedPayload(
  toolPartType: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
): { filePath: string } | null {
  if (!WRITE_TOOL_PART_TYPES_FOR_FILE_CHANGED_IPC.has(toolPartType)) return null;
  const raw = typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined;
  if (!raw) return null;
  const filePath = resolveWriteToolFilePathForIpc(raw, cwd);
  if (!filePath) return null;
  return { filePath };
}

/**
 * Notify renderer to reload open editor tabs after a write tool completes (tRPC chat + socket executor).
 * No-op when payload cannot be built (wrong tool, missing path, etc.).
 */
export function broadcastWriteToolFileChangedIpc(
  toolPartType: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  subChatId: string,
): void {
  const payload = tryBuildWriteToolFileChangedPayload(toolPartType, toolInput, cwd);
  if (!payload) return;
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('file-changed', {
      filePath: payload.filePath,
      type: toolPartType,
      subChatId,
    });
  }
}
