import type { Dirent, Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolvePathInWorktree } from '../../git/security/path-validation';

type EntryKind = 'file' | 'folder' | null;

function kindOf(entry: Dirent | Stats): EntryKind {
  if (entry.isDirectory()) return 'folder';
  return entry.isFile() ? 'file' : null;
}

/** files.entryType: what sits at a path inside a project, read from the disk as it is now.
 * Null when nothing is there, or when the path leaves the project. Links are followed. */
export async function findEntryType(projectPath: string, relativePath: string): Promise<EntryKind> {
  try {
    return kindOf(await stat(resolvePathInWorktree(projectPath, relativePath)));
  } catch {
    return null;
  }
}

/** A directory listing row's kind. A link takes its target's kind; a broken or looping link is null. */
export async function direntKind(entry: Dirent, fullPath: string): Promise<EntryKind> {
  if (!entry.isSymbolicLink()) return kindOf(entry);
  try {
    return kindOf(await stat(fullPath));
  } catch {
    return null;
  }
}
