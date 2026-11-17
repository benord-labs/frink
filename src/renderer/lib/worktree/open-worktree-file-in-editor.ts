import path from 'path';
import { getDecodedBasename } from '@/lib/get-decoded-basename';
import { isWindowsAbsolutePath } from '../../../shared/lib/path-normalization';

// This helper may receive raw provider paths, so handle both slash styles.
const RELATIVE_PATH_ESCAPE_REGEX = /^\.\.(?:[\\/]|$)/;

type BuildOpenWorktreeFileInput = {
  filePath: string;
  /** The folder the chat works in: its worktree, or the project itself when it has none. */
  worktreePath: string | null | undefined;
  /** False when that folder is the project itself. */
  isWorktreeContext?: boolean;
  chatId: string;
};

export function buildOpenWorktreeFileInput({
  filePath,
  worktreePath,
  isWorktreeContext = true,
  chatId,
}: BuildOpenWorktreeFileInput): {
  path: string;
  name: string;
  projectPath: string;
  isWorktreeContext: boolean;
  sourceChatId: string;
  intent: 'pinned';
} | null {
  if (!worktreePath) return null;
  if (filePath.startsWith('file://')) return null;

  const isAbsolute = path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
  const relativePath = isAbsolute ? path.relative(worktreePath, filePath) : filePath;
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    RELATIVE_PATH_ESCAPE_REGEX.test(relativePath)
  ) {
    return null;
  }
  const fileName = getDecodedBasename(filePath);

  return {
    path: relativePath,
    name: fileName,
    projectPath: worktreePath,
    isWorktreeContext,
    sourceChatId: chatId,
    intent: 'pinned',
  };
}
