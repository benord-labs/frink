/**
 * Shared skill-dir filesystem helpers (PCH-2).
 *
 * Extracted from `skill-provisioner.ts` so BOTH the boot provisioner (frink-shipped
 * skills) and the spawn-time projection (`skill-projection.ts`, user skills) reuse one
 * implementation without an import cycle. Pure FS + hashing — no electron, no homedir.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { replaceDirectory } from '../platform';

/** Files larger than this are hashed via a stream (bounded memory) instead of readFile. */
const STREAM_HASH_THRESHOLD = 256 * 1024;

export function sha256(content: Buffer | string): string {
  const hash = createHash('sha256');
  hash.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  return hash.digest('hex');
}

/**
 * Two-step rename for "replace dest with src" since fs.rename refuses an existing
 * non-empty target on most platforms. The window between renames is sub-ms
 * (same-filesystem moves). Callers serialize via a mutex where concurrency matters.
 */
export async function replaceDir(src: string, dest: string): Promise<void> {
  await replaceDirectory(src, dest, { backupPath: `${dest}.old-${Date.now()}` });
}

/** SHA-256 of one file. Streams files over the threshold so a large skill asset
 *  (PDF, image, sample data) never lands whole in main-process memory. */
export async function hashFile(abs: string): Promise<string> {
  const { size } = await stat(abs);
  if (size <= STREAM_HASH_THRESHOLD) return sha256(await readFile(abs));
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/** Copy `relPaths` from `from` into `into`, creating parent dirs; `dereference` copies what
 *  a symlink points to instead of the link. */
export async function copyFiles(
  from: string,
  into: string,
  relPaths: string[],
  { dereference = false } = {},
): Promise<void> {
  for (const relPath of relPaths) {
    await mkdir(dirname(join(into, relPath)), { recursive: true });
    await cp(join(from, relPath), join(into, relPath), { dereference });
  }
}

/**
 * How a walk treats symlinks: `skip` them, `list` them unfollowed (`links` names them), or
 * `follow` them into what they point to, never re-entering a folder it is already inside.
 */
type LinkMode = 'skip' | 'list' | 'follow';
type Listing = {
  entries: { rel: string; abs: string }[];
  links: string[];
  unreadable: string[];
  /** Folders below the root with nothing in them. */
  empty: string[];
};
type Walk = { root: string; exclude: ReadonlySet<string>; mode: LinkMode; seen: Set<string> };

const toRel = (root: string, abs: string): string => relative(root, abs).split('\\').join('/');

/** Resolve a symlink met in `follow` mode: list a folder, record a file, or report it unreadable. */
async function followLink(walk: Walk, abs: string, found: Listing): Promise<void> {
  const target = await stat(abs).catch(() => null);
  if (target?.isDirectory()) await listTree(walk, abs, found);
  else if (target?.isFile()) found.entries.push({ rel: toRel(walk.root, abs), abs });
  else found.unreadable.push(toRel(walk.root, abs));
}

/** Handle one symlink by the walk's mode: follow it, list it unfollowed, or skip it. */
async function visitLink(walk: Walk, abs: string, found: Listing): Promise<void> {
  if (walk.mode === 'follow') return followLink(walk, abs, found);
  if (walk.mode === 'list') found.links.push(toRel(walk.root, abs));
}

/** Read a folder's entries, reporting it as unreadable (`.` for the root) when it can't be. */
async function readEntries(walk: Walk, dir: string, found: Listing) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    found.unreadable.push(toRel(walk.root, dir) || '.');
    return [];
  }
}

/** List a dir tree (excluding `exclude` names) with cross-platform relpaths. */
async function listTree(walk: Walk, dir: string, found: Listing): Promise<void> {
  // Only a folder that is its own ancestor is skipped (a loop); another path to it is listed.
  const real = await realpath(dir).catch(() => dir);
  if (walk.seen.has(real)) return;
  walk.seen.add(real);
  const entries = (await readEntries(walk, dir, found)).filter((e) => !walk.exclude.has(e.name));
  if (entries.length === 0 && dir !== walk.root) found.empty.push(toRel(walk.root, dir));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await listTree(walk, abs, found);
    else if (entry.isFile()) found.entries.push({ rel: toRel(walk.root, abs), abs });
    else if (entry.isSymbolicLink()) await visitLink(walk, abs, found);
  }
  walk.seen.delete(real);
}

/** One `[relpath, perFile]` pair per entry; an entry `perFile` cannot read goes in `unreadable`. */
async function walkFiles(
  dir: string,
  exclude: ReadonlySet<string>,
  perFile: (abs: string) => Promise<string>,
  mode: LinkMode = 'skip',
): Promise<{ pairs: [string, string][]; links: string[]; unreadable: string[]; empty: string[] }> {
  const found: Listing = { entries: [], links: [], unreadable: [], empty: [] };
  await listTree({ root: dir, exclude, mode, seen: new Set() }, dir, found);
  const pairs: [string, string][] = [];
  for (const { rel, abs } of found.entries) {
    await perFile(abs).then(
      (value) => pairs.push([rel, value]),
      () => found.unreadable.push(rel),
    );
  }
  return { pairs, links: found.links, unreadable: found.unreadable, empty: found.empty };
}

/** Order-independent digest of `[relpath, value]` pairs. */
function digest(pairs: [string, string][]): string {
  return sha256(
    pairs
      .map(([rel, value]) => `${rel}:${value}`)
      .sort()
      .join('\n'),
  );
}

/** Content hash per readable file (`relpath → sha256`) plus unreadable paths. `follow` reads
 *  symlinks as their targets; otherwise they are listed unfollowed and named in `links`. */
export async function readTree(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
  follow = false,
): Promise<{
  files: Record<string, string>;
  links: string[];
  unreadable: string[];
  empty: string[];
}> {
  const { pairs, links, unreadable, empty } = await walkFiles(
    dir,
    exclude,
    hashFile,
    follow ? 'follow' : 'list',
  );
  return { files: Object.fromEntries(pairs), links, unreadable, empty };
}

/** The `dirHash` of a tree whose per-file hashes are already known — no file reads. */
export function dirHashOf(files: Record<string, string>): string {
  return digest(Object.entries(files));
}

/**
 * A stable CONTENT hash of a directory tree (sorted `relpath:sha256` of every file,
 * excluding `exclude` names). Order-independent + cross-platform paths.
 */
export async function dirHash(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string> {
  return digest((await walkFiles(dir, exclude, hashFile)).pairs);
}

/**
 * A cheap STAT signature of a directory tree (sorted `relpath:mtimeMs:size:ino`, no file
 * reads). A fast-path change probe: when it matches the value stored at projection
 * time, the tree is *probably* unchanged and the expensive `dirHash` can be skipped.
 * NOT authoritative — `touch -r` / same-size edits can collide; content hashes are the
 * fallback that decides preserve-vs-overwrite. Order-independent + cross-platform.
 */
export async function dirStatSig(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
  follow = false,
): Promise<string> {
  // The inode tells apart two same-size, same-time files a symlink is repointed between.
  const sigOf = async (abs: string, read: typeof stat) => {
    const st = await read(abs);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  };
  const { pairs, links, empty } = await walkFiles(
    dir,
    exclude,
    (abs) => sigOf(abs, follow ? stat : lstat),
    follow ? 'follow' : 'list',
  );
  // An empty folder counts too, so adding or removing one is seen.
  for (const rel of empty) pairs.push([`${rel}/`, 'empty']);
  // An unfollowed symlink still counts, by its own stat.
  for (const rel of links) {
    await sigOf(join(dir, rel), lstat).then(
      (sig) => pairs.push([rel, `link:${sig}`]),
      () => {},
    );
  }
  return digest(pairs);
}
