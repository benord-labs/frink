/** Pure comparisons a projection reconcile is built from: kept entries, leftover links, and
 *  path clashes. No writes. */

import { readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

type FileHashes = Record<string, string>;

/** `taken`, except each `kept` file carries its `previous` entry (or none) so it stays edited. */
export function withKeptEntries(
  taken: FileHashes,
  kept: string[],
  previous: FileHashes,
): FileHashes {
  const keep = new Set(kept);
  return Object.fromEntries([
    ...Object.entries(taken).filter(([rel]) => !keep.has(rel)),
    ...Object.entries(previous).filter(([rel]) => keep.has(rel)),
  ]);
}

/** Symlinks in the copy that resolve exactly where the source path does (`rel → link text`):
 *  left by an older projection, so they are removed and replaced by real files. */
export async function leftoverLinks(
  sourceDir: string,
  target: string,
  links: string[],
): Promise<FileHashes> {
  const resolved = (path: string) => realpath(path).catch(() => undefined);
  const leftovers: FileHashes = {};
  for (const rel of links) {
    // Read once and resolve from that text, so a link retargeted meanwhile is never matched by
    // its old resolution; the swap later re-checks the same text.
    const link = join(target, rel);
    const text = await readlink(link).catch(() => undefined);
    if (text === undefined) continue;
    const [mine, theirs] = await Promise.all([
      resolved(resolve(dirname(link), text)),
      resolved(join(sourceDir, rel)),
    ]);
    if (mine !== undefined && mine === theirs) leftovers[rel] = text;
  }
  return leftovers;
}

/** Leftover symlinks split by what the source has at that path: a file or a folder. */
export function splitLeftovers(leftovers: FileHashes, sourceFiles: FileHashes) {
  const entries = Object.entries(leftovers);
  return {
    fileLeftovers: Object.fromEntries(entries.filter(([rel]) => Object.hasOwn(sourceFiles, rel))),
    folderLeftovers: Object.fromEntries(
      entries.filter(([rel]) => !Object.hasOwn(sourceFiles, rel)),
    ),
  };
}

/** True when `rel` and a kept path cannot both exist: one is a folder the other lives in. */
export function clashesWithKept(rel: string, kept: string[]): boolean {
  return kept.some((path) => path.startsWith(`${rel}/`) || rel.startsWith(`${path}/`));
}
