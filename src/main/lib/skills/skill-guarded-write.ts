/** Writes into a projected skill copy that stage new content first and never replace or
 *  remove an entry that changed since the comparison. */

import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import log from 'electron-log';
import { copyFiles, hashFile, readTree } from './skill-fs';

/** lstat that does NOT follow the link (a DANGLING symlink is still seen). Null only when
 *  nothing is there; any other failure (such as no permission to look) throws. */
export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))
      return null;
    throw err;
  }
}

/** True when a folder on the way to `rel` inside `target` is a symlink. */
export async function throughLink(target: string, rel: string): Promise<boolean> {
  const parts = rel.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    if ((await lstatOrNull(join(target, ...parts.slice(0, depth))))?.isSymbolicLink()) return true;
  }
  return false;
}

let scratchCount = 0;
/** A scratch path beside the copy, named as crash debris so a later sweep removes it. */
function scratchPath(target: string): string {
  scratchCount += 1;
  return `${target}.staging-${process.pid}-${Date.now()}${scratchCount}`;
}

/**
 * Move `from` (a file, symlink or empty folder) to `dest` only if nothing is at `dest`, using
 * calls that fail rather than replace; false when `dest` is taken.
 */
async function placeIfFree(from: string, dest: string): Promise<boolean> {
  // The parent may have been removed meanwhile; mkdir never replaces anything already there.
  await mkdir(dirname(dest), { recursive: true });
  const st = await lstatOrNull(from);
  const create = st?.isSymbolicLink()
    ? async () => symlink(await readlink(from), dest)
    : st?.isDirectory()
      ? () => mkdir(dest)
      : () => link(from, dest);
  const placed = await create().then(
    () => true,
    async (err) => {
      if (await lstatOrNull(dest)) return false;
      throw err;
    },
  );
  if (placed) await rm(from, { recursive: true, force: true });
  return placed;
}

/** Return a moved-aside entry to `dest`, or beside it under a visible name if `dest` is taken. */
export async function putBack(aside: string, dest: string): Promise<void> {
  if (await placeIfFree(aside, dest)) return;
  // Never overwrite: a fresh random name, placed with the same no-replace calls.
  const kept = `${dest}.frink-kept-${randomUUID()}`;
  if (!(await placeIfFree(aside, kept))) throw new Error(`could not put back ${dest}`);
  log.warn(`[skill-projection] ${dest} changed during an update; kept as ${kept}`);
}

/** What a symlink is expected to hold, in the same space as a file's content hash. */
export const linkExpectation = (text: string): string => `link:${text}`;

/** A file's content hash or a symlink's link expectation; null for anything else or unreadable. */
async function seenAt(path: string): Promise<string | null> {
  const st = await lstatOrNull(path);
  if (st?.isSymbolicLink()) return linkExpectation(await readlink(path));
  return st?.isFile() ? hashFile(path).catch(() => null) : null;
}

/** What an entry that is gone means: as expected when nothing was expected, else a change. */
const goneAs = (expected: string | undefined) => (expected === undefined ? 'absent' : null);

/** Rename `dest` to a scratch path; null if it vanished first. Any other failure throws. */
export async function moveAside(target: string, dest: string): Promise<string | null> {
  const aside = scratchPath(target);
  try {
    await rename(dest, aside);
    return aside;
  } catch (err) {
    if (!(await lstatOrNull(dest))) return null;
    throw err;
  }
}

/** A folder at `dest` gives way only when it was an expected empty one; rmdir only ever
 *  removes an empty folder, so it cannot take anything with content. */
async function takeFolder(
  dest: string,
  expected: string | undefined,
  emptyFolderOk: boolean,
): Promise<'absent' | 'emptied' | null> {
  if (expected !== undefined || !emptyFolderOk) return null;
  try {
    await rmdir(dest);
    return 'emptied';
  } catch (err) {
    // Gone already is fine; something put into it is a change; anything else is a real error.
    if (!(await lstatOrNull(dest))) return 'absent';
    if ((await readdir(dest).catch(() => [])).length > 0) return null;
    throw err;
  }
}

/** Move `dest` aside and return that path if it is what was compared; `absent` if nothing was
 *  there as expected, `emptied` if an allowed empty folder was removed; else put back, null. */
async function takeIfUnchanged(
  target: string,
  dest: string,
  expected: string | undefined,
  emptyFolderOk: boolean,
): Promise<string | 'absent' | 'emptied' | null> {
  const st = await lstatOrNull(dest);
  if (!st) return goneAs(expected);
  if (st.isDirectory()) return takeFolder(dest, expected, emptyFolderOk);
  const aside = await moveAside(target, dest);
  if (aside === null) return goneAs(expected);
  // A file where none was expected, or one that cannot be read, is never a match.
  if (expected !== undefined && (await seenAt(aside)) === expected) return aside;
  await putBack(aside, dest);
  return null;
}

/** Remove each folder above `rel` that is now empty, up to `target`. */
async function removeEmptyParents(target: string, rel: string): Promise<void> {
  for (let dir = dirname(join(target, rel)); dir !== target; dir = dirname(dir)) {
    const removed = await rmdir(dir).then(
      () => true,
      () => false,
    );
    if (!removed) return;
  }
}

/** True when `taken` is a moved-aside entry rather than a marker for "nothing was there". */
const isAside = (taken: string): boolean => taken !== 'absent' && taken !== 'emptied';

/** Remove a dropped file if it is still what the comparison saw; false if it changed. */
export async function dropFile(target: string, rel: string, expected: string): Promise<boolean> {
  // A path through a symlink in the copy could reach outside it, so it is never touched.
  if (await throughLink(target, rel)) return false;
  const taken = await takeIfUnchanged(target, join(target, rel), expected, false);
  if (taken === null) return false;
  if (isAside(taken)) await rm(taken, { force: true });
  await removeEmptyParents(target, rel);
  return true;
}

/** Put the source `rel` in place (copied first) if the entry is still what was compared;
 *  returns the hash placed, or null if it changed. */
export async function replaceFile(
  sourceDir: string,
  target: string,
  rel: string,
  expected: string | undefined,
  emptyFolderOk: boolean,
): Promise<string | null> {
  if (await throughLink(target, rel)) return null;
  const fresh = scratchPath(target);
  await cp(join(sourceDir, rel), fresh, { dereference: true });
  const dest = join(target, rel);
  try {
    // What lands is what was copied, even if the source changed since the comparison.
    const freshHash = await hashFile(fresh);
    const taken = await takeIfUnchanged(target, dest, expected, emptyFolderOk);
    if (taken === null) return null;
    try {
      // Checked again just before writing: a folder swapped for a symlink meanwhile stops it.
      const placed = !(await throughLink(target, rel)) && (await placeIfFree(fresh, dest));
      // When something took `dest` meanwhile, the original is kept beside it, never deleted.
      if (isAside(taken)) await (placed ? rm(taken, { force: true }) : putBack(taken, dest));
      return placed ? freshHash : null;
    } catch (err) {
      if (isAside(taken)) await putBack(taken, dest);
      if (taken === 'emptied') await mkdir(dest).catch(() => {});
      throw err;
    }
  } finally {
    await rm(fresh, { force: true });
  }
}

/** Stage a real copy of the source folder at `rel`; returns the staged path and its hashes. */
async function stageFolder(sourceDir: string, target: string, rel: string) {
  const staged = scratchPath(target);
  const tree = await readTree(join(sourceDir, rel), new Set(), true);
  if (tree.unreadable.length > 0) throw new Error(`cannot read source folder ${rel}`);
  await mkdir(staged, { recursive: true });
  await copyFiles(join(sourceDir, rel), staged, Object.keys(tree.files), { dereference: true });
  for (const folder of tree.empty) await mkdir(join(staged, folder), { recursive: true });
  return { staged, files: (await readTree(staged)).files, empty: tree.empty };
}

/** Link every staged file into the freshly made `dest`; on any collision or error, remove
 *  only what this placed (never anything else there) and return null. */
async function fillFolder(
  staged: string,
  dest: string,
  files: Record<string, string>,
  empty: string[],
): Promise<Record<string, string> | null> {
  const placed: string[] = [];
  try {
    for (const file of Object.keys(files)) {
      if (!(await placeIfFree(join(staged, file), join(dest, file)))) throw new Error(file);
      placed.push(file);
    }
    for (const folder of empty) await mkdir(join(dest, folder), { recursive: true });
    return files;
  } catch {
    // Each placed file is removed only if it is still what was placed, never a replacement.
    for (const file of placed) await dropFile(dest, file, files[file]);
    await rmdir(dest).catch(() => {});
    return null;
  }
}

/**
 * Swap a leftover symlink at folder path `rel` for a real copy of the source folder, staged in
 * full first; returns the hashes placed (relative to `rel`), or null if the link changed. Only
 * calls that fail rather than replace are used: a fresh `mkdir`, then a link per file.
 */
export async function replaceFolder(
  sourceDir: string,
  target: string,
  rel: string,
  expected: string,
): Promise<Record<string, string> | null> {
  if (await throughLink(target, rel)) return null;
  const { staged, files, empty } = await stageFolder(sourceDir, target, rel);
  try {
    const dest = join(target, rel);
    const taken = await takeIfUnchanged(target, dest, expected, false);
    if (taken === null) return null;
    // The original stays aside until every file has landed; any shortfall or error undoes
    // what was placed and puts it back.
    let placed: Record<string, string> | null = null;
    try {
      const made =
        !(await throughLink(target, rel)) &&
        (await mkdir(dest).then(
          () => true,
          () => false,
        ));
      placed = made ? await fillFolder(staged, dest, files, empty) : null;
    } finally {
      if (isAside(taken)) await (placed ? rm(taken, { force: true }) : putBack(taken, dest));
    }
    return placed;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
