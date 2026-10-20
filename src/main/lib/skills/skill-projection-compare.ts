/** What a projection reconcile reads and compares: its marker, kept entries, leftover links
 *  and path clashes. No writes. */

import { readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { dirHashOf, fileMap, hashFile, readBaseline } from './skill-fs';

type FileHashes = Record<string, string>;

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** `files` that is not a map of hashes reads as absent, like a marker written before it existed. */
const provenanceSchema = z.object({
  // A marker whose hash is not a real hash is as unreadable as no marker at all.
  hash: hashSchema,
  sig: z.string().optional().catch(undefined),
  srcSig: z.string().optional().catch(undefined),
  files: z.record(z.string(), hashSchema).optional().catch(undefined),
  /** Empty folders the source had, so one it later removes can be removed here too. */
  folders: z.array(z.string()).optional().catch(undefined),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** The projection marker at `markerPath`, or null when it is missing, unreadable or invalid. */
export async function readProvenance(markerPath: string): Promise<Provenance | null> {
  try {
    const raw = JSON.parse(await readFile(markerPath, 'utf8'));
    const parsed = provenanceSchema.safeParse(raw).data;
    if (!parsed?.files) return parsed ?? null;
    // The record parse drops a `__proto__` key, so the map is rebuilt from the raw entries.
    const rawFiles = raw.files;
    const files = fileMap();
    if (Object(rawFiles) === rawFiles && !Array.isArray(rawFiles)) {
      for (const [rel, hash] of Object.entries(rawFiles)) {
        const valid = hashSchema.safeParse(hash);
        if (valid.success) files[rel] = valid.data;
      }
    }
    return { ...parsed, files };
  } catch {
    return null;
  }
}

/** Baseline for a shipped copy that has no marker, taken from the copy's own `.baseline.json`,
 *  which is recorded as unedited too so it follows the source. */
export async function adoptedProvenance(target: string): Promise<Provenance> {
  const shipped = Object.entries((await readBaseline(target))?.files ?? {});
  const baselinePath = join(target, '.baseline.json');
  // A file without a recorded hash would read as edited and stay stale for good.
  if (
    shipped.length === 0 ||
    !shipped.every(([, file]) => hashSchema.safeParse(file?.sha256).success)
  ) {
    throw new Error(`${baselinePath} does not record a hash for every file`);
  }
  const files = fileMap(shipped.map(([rel, file]) => [rel, file.sha256]));
  files['.baseline.json'] = await hashFile(baselinePath);
  return { hash: dirHashOf(files), files };
}

/** True when both paths are one folder, as through a tool's skills folder linked to the source. */
export async function sameDir(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a), realpath(b)]);
  return x === y;
}

/** `taken`, except each `kept` file carries its `previous` entry (or none) so it stays edited. */
export function withKeptEntries(
  taken: FileHashes,
  kept: string[],
  previous: FileHashes,
): FileHashes {
  const keep = new Set(kept);
  return fileMap([
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
  const leftovers = fileMap();
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
    fileLeftovers: fileMap(entries.filter(([rel]) => Object.hasOwn(sourceFiles, rel))),
    folderLeftovers: fileMap(entries.filter(([rel]) => !Object.hasOwn(sourceFiles, rel))),
  };
}

/** True when `rel` and a kept path cannot both exist: one is a folder the other lives in. */
export function clashesWithKept(rel: string, kept: string[]): boolean {
  return kept.some((path) => path.startsWith(`${rel}/`) || rel.startsWith(`${path}/`));
}

/** The `dirHash` of a tree from its `readTree` entries: regular files only, as `dirHash` sees it. */
export function contentHash(files: FileHashes, links: string[]): string {
  const link = new Set(links);
  return dirHashOf(fileMap(Object.entries(files).filter(([rel]) => !link.has(rel))));
}
