/**
 * Shared skill-dir filesystem helpers (PCH-2).
 *
 * Extracted from `skill-provisioner.ts` so BOTH the boot provisioner (frink-shipped
 * skills) and the spawn-time projection (`skill-projection.ts`, user skills) reuse one
 * implementation without an import cycle. Pure FS + hashing — no electron, no homedir.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
async function hashFile(abs: string): Promise<string> {
  const { size } = await stat(abs);
  if (size <= STREAM_HASH_THRESHOLD) return sha256(await readFile(abs));
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/**
 * Walk a dir tree (excluding `exclude` names), emitting one `relpath:<perFile>` line
 * per file. Shared by `dirHash` (content) and `dirStatSig` (stat) so the tree walk +
 * cross-platform relpath normalization live in ONE place. A per-file failure is skipped.
 */
async function walkFiles(
  root: string,
  dir: string,
  exclude: ReadonlySet<string>,
  perFile: (abs: string) => Promise<string>,
  out: string[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, abs, exclude, perFile, out);
    } else if (entry.isFile()) {
      try {
        const rel = relative(root, abs).split('\\').join('/');
        out.push(`${rel}:${await perFile(abs)}`);
      } catch {
        // unreadable file — skip
      }
    }
  }
}

/**
 * A stable CONTENT hash of a directory tree (sorted `relpath:sha256` of every file,
 * excluding `exclude` names). The authoritative change signal for the projection
 * reconcile (detects a user-edited copy). Order-independent + cross-platform paths.
 */
export async function dirHash(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string> {
  const lines: string[] = [];
  await walkFiles(dir, dir, exclude, hashFile, lines);
  lines.sort();
  return sha256(lines.join('\n'));
}

/**
 * A cheap STAT signature of a directory tree (sorted `relpath:mtimeMs:size`, no file
 * reads). A fast-path change probe: when it matches the value stored at projection
 * time, the tree is *probably* unchanged and the expensive `dirHash` can be skipped.
 * NOT authoritative — `touch -r` / same-size edits can collide; `dirHash` is the
 * fallback that decides preserve-vs-overwrite. Order-independent + cross-platform.
 */
export async function dirStatSig(
  dir: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<string> {
  const lines: string[] = [];
  await walkFiles(
    dir,
    dir,
    exclude,
    async (abs) => {
      const st = await stat(abs);
      return `${st.mtimeMs}:${st.size}`;
    },
    lines,
  );
  lines.sort();
  return sha256(lines.join('\n'));
}
