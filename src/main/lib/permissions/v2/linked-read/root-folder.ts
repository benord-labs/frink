import os from 'node:os';
import path from 'node:path';
import { isRootLikePath } from '../../../../../shared/lib/path-normalization';
import { isPathWithinProject, resolveToRealPath } from '../../path-check';
import { SYSTEM_DENIED_EXACT } from '../system-denied-patterns';

// macOS also shows every user folder under its data volume, and realpath keeps that spelling.
const DATA_VOLUME = '/System/Volumes/Data';

/** Home and the protected folders in it, with their data-volume spellings on macOS. Read it once
 * and pass it to isRootFolder when checking many folders. */
export function guardedFolders(): string[] {
  const folders = [os.homedir(), ...SYSTEM_DENIED_EXACT];
  if (process.platform !== 'darwin') return folders;
  return [
    ...folders,
    ...folders.map((folder) => path.join(DATA_VOLUME, resolveToRealPath(folder))),
  ];
}

/** `/` or a drive root, home, or a folder holding home or a protected folder such as `~/.ssh`,
 * however it is spelled: by real path, so a link to `/` or `/Users/..` counts as `/`. Such a
 * folder is never linked, and a linked folder that has since become one grants nothing. */
export function isRootFolder(dir: string, guarded: readonly string[] = guardedFolders()): boolean {
  const real = resolveToRealPath(path.resolve(dir));
  return (
    isRootLikePath(dir) ||
    isRootLikePath(real) ||
    guarded.some((inner) => isPathWithinProject(inner, real))
  );
}
