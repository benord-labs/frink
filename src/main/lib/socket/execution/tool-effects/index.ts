import path from 'node:path';
import { BrowserWindow } from 'electron';
import { z } from 'zod';
import { FILE_WRITE_TOOLS } from '../../../../../shared/types/permissions';
import type { UIMessageChunk } from '../../../claude/types';

/** The renderer's `file-changed` payload (preload onFileChanged). */
export type FileChangedEvent = { filePath: string; type: string; subChatId: string };

type ToolCard = Extract<UIMessageChunk, { type: 'tool-input-available' }>;

// NotebookEdit names its file `notebook_path`; every other write tool uses `file_path`.
const fileInputSchema = z.union([
  z.object({ file_path: z.string().min(1) }).transform((input) => input.file_path),
  z.object({ notebook_path: z.string().min(1) }).transform((input) => input.notebook_path),
]);

/** The file a write card names, resolved against the chat folder; null for any other card. */
function writtenFile(card: ToolCard, cwd: string): string | null {
  if (!FILE_WRITE_TOOLS.has(card.toolName)) return null;
  const parsed = fileInputSchema.safeParse(card.input);
  return parsed.success ? path.resolve(cwd, parsed.data) : null;
}

/** Tells every live window a file changed. A crashed renderer keeps isDestroyed() false, so
 * check both. */
function broadcastFileChanged(change: FileChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) {
      win.webContents.send('file-changed', change);
    }
  }
}

/** A tool-call stream's effects. It keeps only the file each unfinished write names, and the
 * latest card per call id wins (ACP re-sends input; Copilot splits a patch into `id#n` cards). */
export function createToolEffects(
  cwd: string,
  subChatId: string,
  notify: (change: FileChangedEvent) => void = broadcastFileChanged,
): (chunk: UIMessageChunk) => void {
  const pending = new Map<string, FileChangedEvent>();
  return (chunk) => {
    if (chunk.type === 'tool-input-available') {
      const filePath = writtenFile(chunk, cwd);
      if (filePath) {
        pending.set(chunk.toolCallId, { filePath, type: `tool-${chunk.toolName}`, subChatId });
      } else pending.delete(chunk.toolCallId);
    }
    if (chunk.type !== 'tool-output-available' && chunk.type !== 'tool-output-error') return;
    const change = pending.get(chunk.toolCallId);
    pending.delete(chunk.toolCallId);
    if (change && chunk.type === 'tool-output-available') notify(change);
  };
}
