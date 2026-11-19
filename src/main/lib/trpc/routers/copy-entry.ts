import type { Stats } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readlink, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

type CopyEntry = { path: string; isLink: boolean };

const BROKEN_TARGET = new Set(['ENOENT', 'ELOOP', 'ENOTDIR']);

/** Recursively list every file and link inside a directory (for progress counting).
 *  Links are leaves, so data outside the project is never walked or copied. */
export async function listAllFiles(dir: string): Promise<CopyEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: CopyEntry[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAllFiles(full)));
    } else {
      files.push({ path: full, isLink: entry.isSymbolicLink() });
    }
  }
  return files;
}

/** Copy a file, or recreate a link as written. Windows folder links become junctions, which
 *  need no Developer Mode but must point at an absolute path. */
export async function copyEntry(source: string, dest: string, isLink: boolean): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (!isLink) return copyFile(source, dest);
  const onWindows = process.platform === 'win32';
  let target: Stats | null = null;
  // Only a missing or looping target counts as a broken link; an unreadable one does not.
  let broken = false;
  if (onWindows) {
    try {
      target = await stat(source);
    } catch (error) {
      broken = error instanceof Error && 'code' in error && BROKEN_TARGET.has(String(error.code));
    }
  }
  if (target?.isDirectory()) {
    return symlink(resolve(dirname(source), await readlink(source)), dest, 'junction');
  }
  try {
    await cp(source, dest, { verbatimSymlinks: true });
  } catch (error) {
    // Windows file links need Developer Mode: copy the file it points at, drop a broken one.
    // Anything else rethrows, so a move never deletes a source it failed to copy.
    const eperm = error instanceof Error && 'code' in error && error.code === 'EPERM';
    if (!onWindows || !eperm || !(target || broken)) throw error;
    if (target) await copyFile(source, dest);
  }
}
