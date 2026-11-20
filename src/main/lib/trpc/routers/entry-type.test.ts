import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntryKinds, findEntryType, STAT_TIMEOUT_MS } from './entry-type';

interface Waiter {
  path: string;
  resolve: (stats: Stats) => void;
  reject: (error: Error) => void;
}

/** A disk whose stat on the given paths hangs until the test answers, like an unresponsive mount. */
function hangingDisk(...paths: string[]) {
  const hung = new Set(paths);
  const calls: string[] = [];
  const waiters: Waiter[] = [];
  const kinds = createEntryKinds({
    stat: (path) => {
      if (!hung.has(path)) return stat(path);
      calls.push(path);
      return new Promise((resolve, reject) => waiters.push({ path, resolve, reject }));
    },
    // A hung path reads as a link leaving the project, without waiting on real I/O.
    lstat: (path) => (hung.has(path) ? Promise.resolve(linkInfo) : lstat(path)),
    readlink: (path) => (hung.has(path) ? Promise.reject(new Error('EINVAL')) : readlink(path)),
  });
  return {
    ...kinds,
    statCalls: (path: string) => calls.filter((call) => call === path).length,
    /** The newest stat still waiting on `path`. */
    answer: (path: string) => waiters.findLast((waiter) => waiter.path === path),
  };
}

/** A disk where one folder inside the project, a mount itself, never answers an lstat. */
function hangingFolderDisk(folder: string, links: Record<string, string> = {}) {
  let folderLstats = 0;
  const kinds = createEntryKinds({
    stat: (path) => stat(path),
    lstat: (path) => {
      if (path in links) return Promise.resolve(linkInfo);
      if (path !== folder) return lstat(path);
      folderLstats += 1;
      return new Promise(() => {});
    },
    readlink: (path) => (path in links ? Promise.resolve(links[path]) : readlink(path)),
  });
  return { ...kinds, folderLstats: () => folderLstats };
}

/** A disk of folders and the given links (path to target), where every file's stat hangs. */
function linkedDisk(links: Record<string, string>) {
  const calls: string[] = [];
  const kinds = createEntryKinds({
    stat: (path) => {
      calls.push(path);
      return new Promise(() => {});
    },
    lstat: async (path) => (path in links ? linkInfo : folderInfo),
    readlink: async (path) => links[path] ?? Promise.reject(new Error('EINVAL')),
  });
  return { ...kinds, statCalls: (path: string) => calls.filter((call) => call === path).length };
}

// SAFETY: direntKind reads only isSymbolicLink on a row, and every row here is a link.
const link = { isSymbolicLink: () => true } as Dirent;
// SAFETY: the walk to a path's first link reads only isSymbolicLink and isDirectory.
const linkInfo = { isSymbolicLink: () => true, isDirectory: () => false } as Stats;
// SAFETY: as above, for a plain folder on the way.
const folderInfo = { isSymbolicLink: () => false, isDirectory: () => true } as Stats;
// SAFETY: kindOf reads only isDirectory and isFile from a stat result.
const asFile = { isDirectory: () => false, isFile: () => true } as Stats;
const settled = () => new Promise((done) => setImmediate(done));
const root = resolve('/proj');
const [a, b, c] = ['/net/a', '/net/b', '/net/c'].map((path) => resolve(path));

async function write(root: string, relativePath: string): Promise<void> {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), 'x', 'utf8');
}

describe('findEntryType', () => {
  let project: string;
  let outside: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'frink-entry-type-proj-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-entry-type-out-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('tells a file from a folder, and reports nothing where neither is', async () => {
    await write(project, 'src/main/index.ts');

    await expect(findEntryType(project, 'src/main/index.ts')).resolves.toBe('file');
    await expect(findEntryType(project, 'src/main')).resolves.toBe('folder');
    await expect(findEntryType(project, 'src/main/gone.ts')).resolves.toBeNull();
    await expect(findEntryType(project, 'src/main/index.ts/inside')).resolves.toBeNull();
  });

  // The project file search skips build output, tool folders, logs and lock files.
  it.each([
    'build/entitlements.mac.plist',
    'dist/index.js',
    '.vscode/settings.json',
    'vendor/lib/x.go',
    'coverage/lcov.info',
    'logs/app.log',
    'bun.lock',
  ])('finds %s, which the project file search leaves out', async (relativePath) => {
    await write(project, relativePath);

    await expect(findEntryType(project, relativePath)).resolves.toBe('file');
  });

  it('follows a linked file and a linked folder to what they point at', async () => {
    await write(outside, 'notes/today.md');
    await symlink(join(outside, 'notes/today.md'), join(project, 'today.md'));
    await symlink(join(outside, 'notes'), join(project, 'notes'));
    await symlink(join(outside, 'gone.md'), join(project, 'dangling.md'));

    await expect(findEntryType(project, 'today.md')).resolves.toBe('file');
    await expect(findEntryType(project, 'notes')).resolves.toBe('folder');
    await expect(findEntryType(project, 'notes/today.md')).resolves.toBe('file');
    await expect(findEntryType(project, 'dangling.md')).resolves.toBeNull();
  });

  it('reports nothing for a path that leaves the project', async () => {
    await write(outside, 'secret.txt');
    const secret = join(outside, 'secret.txt');

    await expect(findEntryType(project, relative(project, secret))).resolves.toBeNull();
    await expect(findEntryType(project, secret)).resolves.toBeNull();
  });
});

describe('direntKind on a link whose target does not answer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts one stat per hung path, stops at the stuck limit, and checks again once the mount answers', async () => {
    const disk = hangingDisk(a, b, c);
    const first = disk.direntKind(link, a, root);
    await settled();
    const second = disk.direntKind(link, a, root);
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(first).resolves.toBe('unavailable');
    await expect(second).resolves.toBe('unavailable');
    expect(disk.statCalls(a)).toBe(1);

    // Known stuck: answers at once, without another stat or another wait.
    await expect(disk.direntKind(link, a, root)).resolves.toBe('unavailable');
    expect(disk.statCalls(a)).toBe(1);

    const other = disk.direntKind(link, b, root);
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(other).resolves.toBe('unavailable');
    expect(disk.statCalls(b)).toBe(1);

    // Every outside slot holds a stuck stat: a new link answers at once with no stat.
    await expect(disk.direntKind(link, c, root)).resolves.toBe('unavailable');
    expect(disk.statCalls(c)).toBe(0);

    // The mounts answer: a file for a, an error for b. Both slots free up.
    disk.answer(a)?.resolve(asFile);
    disk.answer(b)?.reject(new Error('ETIMEDOUT'));
    await settled();

    const again = disk.direntKind(link, a, root);
    await settled();
    disk.answer(a)?.resolve(asFile);
    await expect(again).resolves.toBe('file');
    expect(disk.statCalls(a)).toBe(2);

    void disk.direntKind(link, c, root);
    await settled();
    expect(disk.statCalls(c)).toBe(1);
  });

  it('sends at most the outside limit of stats to the disk at once, and queues the rest unstuck', async () => {
    const disk = hangingDisk(a, b, c);
    const lookups = [a, b, c].map((path) => disk.direntKind(link, path, root));
    await settled();
    expect([a, b, c].map(disk.statCalls)).toEqual([1, 1, 0]);

    // A slot frees up: the queued link reaches the disk inside its own deadline.
    disk.answer(a)?.resolve(asFile);
    await settled();
    expect(disk.statCalls(c)).toBe(1);
    disk.answer(c)?.resolve(asFile);

    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(Promise.all(lookups)).resolves.toEqual(['file', 'unavailable', 'file']);
  });

  it('gives up on a queued link without marking it stuck', async () => {
    const disk = hangingDisk(a, b, c);
    const lookups = [a, b, c].map((path) => disk.direntKind(link, path, root));
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(Promise.all(lookups)).resolves.toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(disk.statCalls(c)).toBe(0);

    // c left the queue when it gave up, and never touched the disk, so a freed slot doesn't
    // start it and the next lookup asks the disk for real.
    disk.answer(a)?.resolve(asFile);
    await settled();
    expect(disk.statCalls(c)).toBe(0);
    const retry = disk.direntKind(link, c, root);
    await settled();
    disk.answer(c)?.resolve(asFile);
    await expect(retry).resolves.toBe('file');
  });

  it('answers at once for a path through a stuck link, so file badges under it take no worker', async () => {
    const nas = join(root, 'nas');
    const inside = join(nas, 'notes.md');
    const sibling = join(root, 'nasty.md');
    const disk = hangingDisk(nas, inside, sibling);

    const listed = disk.direntKind(link, nas, root);
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(listed).resolves.toBe('unavailable');

    await expect(disk.findEntryType(root, join('nas', 'notes.md'))).resolves.toBe('unavailable');
    expect(disk.statCalls(inside)).toBe(0);

    // Sharing the link's name as a prefix does not put a path inside it.
    void disk.findEntryType(root, 'nasty.md');
    await settled();
    expect(disk.statCalls(sibling)).toBe(1);
  });

  it.each([
    ['a link that leaves the project', { nas: resolve('/away') }, 'nas'],
    [
      'links that stay inside it, then one that leaves',
      { a: 'sub', [join('sub', 'nas')]: resolve('/away') },
      join('a', 'nas'),
    ],
  ])('gives file lookups through %s the same two disk slots', async (_, relativeLinks, through) => {
    const links = Object.fromEntries(
      Object.entries(relativeLinks).map(([at, to]) => [join(root, at), to]),
    );
    const disk = linkedDisk(links);
    const files = ['x.md', 'y.md', 'z.md'].map((name) => join(through, name));
    const lookups = files.map((file) => disk.findEntryType(root, file));
    await settled();
    expect(files.map((file) => disk.statCalls(join(root, file)))).toEqual([1, 1, 0]);

    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(Promise.all(lookups)).resolves.toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });

  it('gives up on a file lookup when a folder on its way never answers, and asks that folder once', async () => {
    const disk = hangingFolderDisk(join(root, 'mnt'), { [join(root, 'a')]: 'mnt' });
    const first = disk.findEntryType(root, join('mnt', 'a.md'));
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await expect(first).resolves.toBe('unavailable');

    await expect(disk.findEntryType(root, join('mnt', 'b.md'))).resolves.toBe('unavailable');
    // Reached through a link inside the project, the stuck folder still answers without a wait.
    await expect(disk.findEntryType(root, join('a', 'c.md'))).resolves.toBe('unavailable');
    expect(disk.folderLstats()).toBe(1);
  });

  it.runIf(process.platform !== 'linux')(
    'matches a stuck link however a chat spells its case, on disks that ignore case',
    async () => {
      const nas = join(root, 'nas');
      const spelled = join(root, 'NAS', 'notes.md');
      const disk = hangingDisk(nas, spelled);
      const listed = disk.direntKind(link, nas, root);
      await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
      await listed;

      await expect(disk.findEntryType(root, join('NAS', 'notes.md'))).resolves.toBe('unavailable');
      expect(disk.statCalls(spelled)).toBe(0);
    },
  );
});

describe('direntKind on a link inside the project while outside links are stuck', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'frink-entry-type-local-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(project, { recursive: true, force: true });
  });

  it('still lists a link to a file in the same project', async () => {
    await write(project, 'AGENTS.md');
    await symlink('AGENTS.md', join(project, 'CLAUDE.md'));
    const dead = [resolve('/net/x'), resolve('/net/y')];
    const disk = hangingDisk(...dead);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck = dead.map((path) => disk.direntKind(link, path, project));
    await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS);
    await Promise.all(stuck);
    vi.useRealTimers();

    await expect(disk.direntKind(link, join(project, 'CLAUDE.md'), project)).resolves.toBe('file');
  });
});
