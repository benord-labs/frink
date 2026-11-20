import type { Dirent, Stats } from 'node:fs';
import { readlink, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { resolvePathInWorktree } from '../../git/security/path-validation';
import { withTimeout } from '../../platform/with-timeout';

/** `unavailable`: the disk didn't answer in time, as on a network drive that has gone away. */
export type EntryKind = 'file' | 'folder' | 'unavailable' | null;

/** The two disk reads this module makes, so a test can stand in a drive that never answers. */
export interface EntryKindFs {
  stat: (path: string) => Promise<Stats>;
  readlink: (path: string) => Promise<string>;
}

export const STAT_TIMEOUT_MS = 2_000;
/** A stat on a hung network mount can't be cancelled and holds one of libuv's 4 fs workers until
 * the mount answers, so links that leave the project share this many and the rest stay free. */
const MAX_OUTSIDE_STATS = 2;

function kindOf(entry: Dirent | Stats): EntryKind {
  if (entry.isDirectory()) return 'folder';
  return entry.isFile() ? 'file' : null;
}

interface PendingStat {
  result: Promise<EntryKind>;
  stuck: boolean;
}

const foldsCase = () => process.platform === 'darwin' || process.platform === 'win32';
const comparable = (path: string) => (foldsCase() ? path.toLowerCase() : path);

function isInside(path: string, folder: string): boolean {
  const [inner, outer] = [comparable(path), comparable(folder)];
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** Every lookup made through one instance shares its stuck paths and its outside slots. */
export function createEntryKinds(fs: EntryKindFs) {
  /** One stat per path at a time: a refresh while a path's stat hangs reuses it, never adds one. */
  const pending = new Map<string, PendingStat>();
  const queuedOutside: (() => void)[] = [];
  let outsideActive = 0;
  let outsideStuck = 0;

  /** A path at or inside a stuck one (a file in a linked folder whose mount hung) hangs too. */
  function isInsideStuckPath(path: string): boolean {
    for (const [pendingPath, entry] of pending) {
      if (entry.stuck && isInside(path, pendingPath)) return true;
    }
    return false;
  }

  function releaseOutsideSlot(): void {
    outsideActive -= 1;
    queuedOutside.shift()?.();
  }

  function startLookup(path: string, outside: boolean): Promise<EntryKind> {
    let dispatched = false;
    let start = () => {};
    const disk = new Promise<EntryKind>((settle) => {
      start = () => {
        dispatched = true;
        if (outside) outsideActive += 1;
        void fs
          .stat(path)
          .then(kindOf, () => null)
          .then((kind) => {
            pending.delete(path);
            if (entry.stuck && outside) outsideStuck -= 1;
            if (outside) releaseOutsideSlot();
            settle(kind);
          });
      };
    });
    const entry: PendingStat = {
      stuck: false,
      result: withTimeout(disk, STAT_TIMEOUT_MS, 'stat timed out').catch(() => {
        if (dispatched) {
          entry.stuck = true;
          if (outside) outsideStuck += 1;
        } else {
          // Still waiting for a slot: it never reached the disk, so nothing is stuck.
          queuedOutside.splice(queuedOutside.indexOf(start), 1);
          pending.delete(path);
        }
        return 'unavailable' as const;
      }),
    };
    pending.set(path, entry);
    if (!outside || outsideActive < MAX_OUTSIDE_STATS) start();
    else queuedOutside.push(start);
    return entry.result;
  }

  /** What a path points at. `outside` lookups (links leaving the project) wait for a slot. */
  function statKind(path: string, outside: boolean): Promise<EntryKind> {
    const entry = pending.get(path);
    if (entry) return entry.stuck ? Promise.resolve('unavailable') : entry.result;
    if (isInsideStuckPath(path)) return Promise.resolve('unavailable');
    // Every slot holds a stat that already timed out, so waiting for one only delays the listing.
    if (outside && outsideStuck >= MAX_OUTSIDE_STATS) return Promise.resolve('unavailable');
    return startLookup(path, outside);
  }

  /** Reading a link touches only the folder that holds it, never the place it points to. */
  async function pointsOutside(linkPath: string, rootPath: string): Promise<boolean> {
    try {
      return !isInside(resolve(dirname(linkPath), await fs.readlink(linkPath)), rootPath);
    } catch {
      return true;
    }
  }

  return {
    /** files.entryType: what sits at a path inside a project, read from the disk as it is now.
     * Null when nothing is there, or when the path leaves the project. Links are followed. */
    findEntryType(projectPath: string, relativePath: string): Promise<EntryKind> {
      let fullPath: string;
      try {
        fullPath = resolvePathInWorktree(projectPath, relativePath);
      } catch {
        return Promise.resolve(null);
      }
      return statKind(fullPath, false);
    },

    /** A directory listing row's kind. A link takes its target's kind; a broken or looping link
     * is null, and one whose target didn't answer is `unavailable`. */
    async direntKind(entry: Dirent, fullPath: string, rootPath: string): Promise<EntryKind> {
      if (!entry.isSymbolicLink()) return kindOf(entry);
      return statKind(fullPath, await pointsOutside(fullPath, rootPath));
    },
  };
}

export type EntryKinds = ReturnType<typeof createEntryKinds>;

export const { findEntryType, direntKind } = createEntryKinds({
  stat: (path) => stat(path),
  readlink: (path) => readlink(path),
});
