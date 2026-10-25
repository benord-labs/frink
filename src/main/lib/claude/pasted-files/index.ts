/** A chat's agent-readable `pasted/` folder: large pastes and attached files, read by path. */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { app } from 'electron';
import { PASTED_FILE_MAX_BYTES } from '../../../../shared/pasted-file-limits';
import { isValidSubChatIdForSessionPaths } from '../session-plan-paths';

type StoredPastedFile = { filePath: string; filename: string; size: number };

const MAX_NAME_BYTES = 200;
const UNREADABLE = "Frink couldn't open this file. Check it still exists and try again.";

/** Shortens the part before the extension, by whole characters, until the name fits in bytes. */
function fitName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  let bytes = Buffer.byteLength(ext);
  const kept: string[] = [];
  for (const char of name.slice(0, name.length - ext.length)) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_NAME_BYTES) break;
    kept.push(char);
  }
  return kept.join('') + ext;
}

/** A name safe on every OS and inside a `[...|...]` mention token. */
export function safeAttachmentName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[/\\[\]|<>:"?*\0-\x1f]/g, '_')
    .replace(/^\.+/, '');
  return (
    fitName(cleaned)
      .replace(/[.\s]+$/, '')
      .trim() || 'attachment'
  );
}

/** Creates and returns the sub-chat's `pasted/` folder under the app's data folder; throws for an
 *  id unsafe in a path. */
export async function pastedDirFor(
  subChatId: string,
  userData = app.getPath('userData'),
): Promise<string> {
  if (!isValidSubChatIdForSessionPaths(subChatId)) throw new Error('Invalid subChatId');
  const dir = join(userData, 'claude-sessions', subChatId, 'pasted');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `<8 hex>-<name>`: a unique name that still reads as the original file. */
function attachedFileName(name: string): string {
  return `${randomUUID().slice(0, 8)}-${safeAttachmentName(name)}`;
}

export async function copyIntoPasted(
  input: { subChatId: string; sourcePath: string },
  userData?: string,
): Promise<StoredPastedFile> {
  if (!isAbsolute(input.sourcePath)) throw new Error('The file path must be absolute.');
  const source = await stat(input.sourcePath).catch(() => {
    throw new Error(UNREADABLE);
  });
  if (!source.isFile()) throw new Error("Folders can't be attached.");
  if (source.size > PASTED_FILE_MAX_BYTES) {
    throw new Error(`Attachments must be under ${PASTED_FILE_MAX_BYTES / (1024 * 1024)} MB.`);
  }
  const filename = attachedFileName(basename(input.sourcePath));
  const filePath = join(await pastedDirFor(input.subChatId, userData), filename);
  await copyFile(input.sourcePath, filePath).catch(() => {
    throw new Error(UNREADABLE);
  });
  return { filePath, filename, size: source.size };
}

export async function writePastedText(
  input: { subChatId: string; text: string; filename?: string },
  userData?: string,
): Promise<StoredPastedFile> {
  const { filename } = input;
  if (filename && (filename.includes('..') || /[/\\]/.test(filename))) {
    throw new Error('Invalid filename');
  }
  const finalFilename = filename || `pasted_${Date.now()}.txt`;
  const filePath = join(await pastedDirFor(input.subChatId, userData), finalFilename);
  await writeFile(filePath, input.text, 'utf-8');
  return { filePath, filename: finalFilename, size: input.text.length };
}
