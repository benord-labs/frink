import type { Dirent, Stats } from 'node:fs';
import { lstat, readlink, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { resolvePathInWorktree } from '../../git/security/path-validation';
import { withTimeout } from '../../platform/with-timeout';

/** `unavailable`: the disk didn't answer in time, as on a network drive that has gone away. */
export type EntryKind = 'file' | 'folder' | 'unavailable' | null;

/** The disk reads this module makes, so a test can stand in a drive that never answers. */
export interface EntryKindFs {
  stat: (path: string) => Promise<Stats>;
  lstat: (path: string) => Promise<Stats>;
  readlink: (path: string) => Promise<string>;
}

export const STAT_TIMEOUT_MS = 2_000;
/** A stat on a hung network mount can't be cancelled and holds one of libuv's 4 fs workers until
 * the mount answers, so links that leave the project share this many and the rest stay free. */
const MAX_OUTSIDE_STATS = 2;
/** Links followed inside the project before a path counts as looping, as the kernel's ELOOP. */
const MAX_LINK_HOPS = 40;

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
  /** One lstat per folder at a time while a file lookup walks its path, like `pending`. */
  const walking = new Map<string, { info: Promise<Stats | null>; stuck: boolean }>();

  /** A path at or inside a stuck one (a file in a linked folder whose mount hung) hangs too. */
  function isInsideStuckPath(path: string): boolean {
    for (const [stuckPath, entry] of [...pending, ...walking]) {
      if (entry.stuck && isInside(path, stuckPath)) return true;
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

  async function lstatBy(path: string, deadline: number): Promise<Stats | null | 'stuck'> {
    let entry = walking.get(path);
    if (!entry) {
      const info = fs.lstat(path).catch(() => null);
      entry = { info, stuck: false };
      walking.set(path, entry);
      void info.then(() => walking.delete(path));
    }
    const own = entry;
    if (own.stuck) return 'stuck';
    return withTimeout(own.info, Math.max(0, deadline - Date.now()), 'lstat timed out').catch(
      () => {
        own.stuck = true;
        return 'stuck' as const;
      },
    );
  }

  /** Follows links at `path` while they stay inside the project: where that ends, or why not. */
  async function followInside(
    path: string,
    rootPath: string,
    deadline: number,
  ): Promise<string | 'outside' | 'stuck'> {
    let current = path;
    for (let hops = 0; hops < MAX_LINK_HOPS; hops += 1) {
      const info = await lstatBy(current, deadline);
      if (info === 'stuck') return 'stuck';
      if (!info?.isSymbolicLink()) return current;
      const at = current;
      const target = await fs.readlink(at).then(
        (to) => resolve(dirname(at), to),
        () => null,
      );
      if (!target || !isInside(target, rootPath)) return 'outside';
      current = target;
    }
    return current;
  }

  /** Whether a path inside the project reaches a link that leaves it, or null when a folder on the
   * way didn't answer in time. Only links are read past, never the drive one points to. */
  async function reachedThroughOutsideLink(
    rootPath: string,
    fullPath: string,
  ): Promise<boolean | null> {
    const deadline = Date.now() + STAT_TIMEOUT_MS;
    let current = rootPath;
    for (const part of relative(rootPath, fullPath).split(sep).filter(Boolean)) {
      const step = await followInside(join(current, part), rootPath, deadline);
      if (step === 'stuck') return null;
      if (step === 'outside') return true;
      current = step;
    }
    return false;
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
      if (isInsideStuckPath(fullPath)) return Promise.resolve('unavailable');
      return reachedThroughOutsideLink(projectPath, fullPath).then((outside) =>
        outside === null ? 'unavailable' : statKind(fullPath, outside),
      );
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
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
});
