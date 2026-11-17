import { stat } from 'node:fs/promises';
import { resolvePathInWorktree } from '../../git/security/path-validation';

/** files.entryType: what sits at a path inside a project, read from the disk as it is now.
 * Null when nothing is there, or when the path leaves the project. Links are followed. */
export async function findEntryType(
  projectPath: string,
  relativePath: string,
): Promise<'file' | 'folder' | null> {
  try {
    const entry = await stat(resolvePathInWorktree(projectPath, relativePath));
    if (entry.isDirectory()) return 'folder';
    return entry.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}
