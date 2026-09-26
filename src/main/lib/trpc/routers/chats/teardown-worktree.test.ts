/** Worktree teardown: tri-state sibling safety, project-delete dedup, boot sweep, retry predicate. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChat } from '../../../db/repos/chats';
import { createProject } from '../../../db/repos/projects';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';

const {
  h,
  removeWorktreeMock,
  listWorktreesMock,
  pruneWorktreesMock,
  dirtyMock,
  unpushedMock,
  managedMock,
  killMock,
  siblingMock,
  configureHooksMock,
  captureContainedMock,
} = vi.hoisted(() => ({
  h: { db: null as unknown },
  removeWorktreeMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  pruneWorktreesMock: vi.fn(),
  dirtyMock: vi.fn(),
  unpushedMock: vi.fn(),
  managedMock: vi.fn(),
  killMock: vi.fn(),
  siblingMock: vi.fn(),
  configureHooksMock: vi.fn(),
  captureContainedMock: vi.fn(),
}));

// Plain mock (no real-db-index spread) — the teardown graph only needs getDatabase, and spreading
// the real db index loads its side effects into the shared worker (cross-file pollution).
vi.mock('../../../db', () => ({ getDatabase: () => h.db }));
// Spread the real module so isTransientWorktreeRemoveError stays real; override the git ops we drive.
vi.mock('../../../git/worktree', async (orig) => ({
  ...(await orig<typeof import('../../../git/worktree')>()),
  removeWorktree: removeWorktreeMock,
  listWorktrees: listWorktreesMock,
  pruneWorktrees: pruneWorktreesMock,
  hasUncommittedChanges: dirtyMock,
  hasUnpushedCommits: unpushedMock,
  isFrinkManagedWorktree: managedMock,
  configureWorktreeHooks: configureHooksMock,
}));
vi.mock('../../../terminal/manager', () => ({
  terminalManager: { killByWorkspaceId: killMock },
}));
vi.mock('../../../sentry', () => ({ captureContained: captureContainedMock }));
vi.mock('../../../db/repos/chats', async (orig) => ({
  ...(await orig<typeof import('../../../db/repos/chats')>()),
  hasOtherActiveChatsSharingWorktree: siblingMock,
}));

import { isTransientWorktreeRemoveError } from '../../../git/worktree';
import {
  hasLiveGitLinkage,
  recoverOrphanedWorktrees,
  removeProjectWorktrees,
  sweepOrphanWorktreeDirs,
  tearDownChatWorktree,
} from './teardown-worktree';

const wt = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  head: 'abc',
  branch: 'b',
  isMain: false,
  prunable: false,
  detached: false,
  ...over,
});

let db: TestDb;
const originalDisableWorktreeRecovery = process.env.FRINK_DISABLE_WORKTREE_RECOVERY;
beforeEach(() => {
  db = freshDb();
  h.db = db;
  vi.clearAllMocks();
  removeWorktreeMock.mockResolvedValue({ success: true });
  killMock.mockResolvedValue(undefined);
  pruneWorktreesMock.mockResolvedValue({ success: true });
  listWorktreesMock.mockResolvedValue([]);
  dirtyMock.mockResolvedValue(false);
  unpushedMock.mockResolvedValue(false);
  managedMock.mockResolvedValue(true);
  configureHooksMock.mockResolvedValue(undefined);
});

// Real temp dirs for the filesystem sweep — never the developer's real ~/.frink/worktrees.
const tmpBases: string[] = [];
const mkTmpBase = (): string => {
  const base = mkdtempSync(join(tmpdir(), 'frink-wt-sweep-'));
  tmpBases.push(base);
  return base;
};
const mkdirp = (...segs: string[]): string => {
  const p = join(...segs);
  mkdirSync(p, { recursive: true });
  return p;
};
afterEach(() => {
  if (originalDisableWorktreeRecovery === undefined) {
    delete process.env.FRINK_DISABLE_WORKTREE_RECOVERY;
  } else {
    process.env.FRINK_DISABLE_WORKTREE_RECOVERY = originalDisableWorktreeRecovery;
  }
  for (const b of tmpBases.splice(0)) rmSync(b, { recursive: true, force: true });
});

describe('isTransientWorktreeRemoveError', () => {
  it('matches the handle-held failure class', () => {
    for (const m of ['EBUSY: resource busy', 'EPERM', 'ENOTEMPTY', 'directory not empty']) {
      expect(isTransientWorktreeRemoveError(m)).toBe(true);
    }
  });
  it('does not match unrelated git errors', () => {
    expect(isTransientWorktreeRemoveError('fatal: not a working tree')).toBe(false);
    expect(isTransientWorktreeRemoveError('is not a valid worktree')).toBe(false);
  });
});

describe('tearDownChatWorktree', () => {
  it('removes when the sibling check confirms zero siblings', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    siblingMock.mockResolvedValue(false);
    const ok = await tearDownChatWorktree(db, {
      id: 'c1',
      worktreePath: '/repo/wt',
      branch: 'feat',
      projectId: project.id,
    });
    expect(ok).toBe(true);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/wt', { branch: 'feat' });
  });

  it('skips removal when a sibling still shares the worktree', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    siblingMock.mockResolvedValue(true);
    const ok = await tearDownChatWorktree(db, {
      id: 'c1',
      worktreePath: '/repo/wt',
      branch: 'feat',
      projectId: project.id,
    });
    expect(ok).toBe(false);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('skips removal when the sibling check throws (indeterminate, not "no siblings")', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    siblingMock.mockRejectedValue(new Error('db busy'));
    const ok = await tearDownChatWorktree(db, {
      id: 'c1',
      worktreePath: '/repo/wt',
      branch: 'feat',
      projectId: project.id,
    });
    expect(ok).toBe(false);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('no-ops when worktree refs are incomplete', async () => {
    const ok = await tearDownChatWorktree(db, {
      id: 'c1',
      worktreePath: null,
      branch: 'feat',
      projectId: 'p1',
    });
    expect(ok).toBe(false);
    expect(siblingMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
});

describe('removeProjectWorktrees', () => {
  it('kills every chat terminal and removes each distinct worktree once', async () => {
    await removeProjectWorktrees('/repo', [
      { id: 'c1', worktreePath: '/repo/a', branch: 'ba' },
      { id: 'c2', worktreePath: '/repo/a', branch: 'ba' }, // shared fork → same path
      { id: 'c3', worktreePath: '/repo/b', branch: 'bb' },
      { id: 'c4', worktreePath: null, branch: null }, // no worktree → skipped
    ]);
    expect(killMock).toHaveBeenCalledTimes(4);
    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/a', { branch: 'ba' });
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/b', { branch: 'bb' });
  });
});

describe('recoverOrphanedWorktrees', () => {
  it('rechecks positive ownership before deletion when a prefetched marker was revoked', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/revoked')]);
    managedMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await recoverOrphanedWorktrees(db, '')).skipped).toBe(1);
    expect(managedMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
  it('cannot reclaim another app instance worktree when QA disables destructive recovery', async () => {
    process.env.FRINK_DISABLE_WORKTREE_RECOVERY = '1';
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/wt-active-in-owner-instance'),
    ]);

    const result = await recoverOrphanedWorktrees(db, '');

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 0, orphaned: 0 });
    expect(listWorktreesMock).not.toHaveBeenCalled();
    expect(pruneWorktreesMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('prunes stale regs, removes unreferenced worktrees, keeps referenced + main', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    await createChat(db, { name: 'keep', projectId: project.id, worktreePath: '/repo/wt-keep' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/wt-keep', { branch: 'bk' }), // referenced by an active chat → keep
      wt('/repo/wt-orphan', { branch: 'bo' }), // no chat → remove
      wt('/repo/wt-stale', { prunable: true, branch: 'bs' }), // dir gone → pruned, not removed
    ]);

    const { pruned, removed, skipped, orphaned } = await recoverOrphanedWorktrees(db, '');

    expect(pruneWorktreesMock).toHaveBeenCalledWith('/repo');
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/wt-orphan', { branch: 'bo' });
    expect(configureHooksMock).toHaveBeenCalledTimes(1);
    expect(configureHooksMock).toHaveBeenCalledWith('/repo', '/repo/wt-keep');
    expect(pruned).toBe(1);
    expect(removed).toBe(1);
    expect(skipped).toBe(0);
    expect(orphaned).toBe(0);
  });

  it('never removes a clean pushed manual worktree without Frink ownership', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/manual-dev-worktree'),
    ]);
    managedMock.mockResolvedValue(false);

    const result = await recoverOrphanedWorktrees(db, '');

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 1, orphaned: 0 });
    expect(managedMock).toHaveBeenCalledWith('/repo/manual-dev-worktree');
    expect(dirtyMock).not.toHaveBeenCalled();
    expect(unpushedMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(configureHooksMock).not.toHaveBeenCalled();
  });

  it('continues orphan recovery when a referenced worktree hook repair fails', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    await createChat(db, { name: 'keep', projectId: project.id, worktreePath: '/repo/wt-keep' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/wt-keep'),
      wt('/repo/wt-orphan', { branch: 'bo' }),
    ]);
    configureHooksMock.mockRejectedValue(new Error('git config locked'));

    const result = await recoverOrphanedWorktrees(db, '');

    expect(result.removed).toBe(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/wt-orphan', { branch: 'bo' });
    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'worktree-hooks',
      stage: 'startup-repair',
    });
  });

  it('fails safe when Frink ownership cannot be read', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/ownership-read-error'),
    ]);
    managedMock.mockRejectedValue(new Error('git config unavailable'));

    const result = await recoverOrphanedWorktrees(db, '');

    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'worktree-ownership', stage: 'startup-prefetch',
    });

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 1, orphaned: 0 });
    expect(dirtyMock).not.toHaveBeenCalled();
    expect(unpushedMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('never force-deletes an unreferenced worktree that holds uncommitted/unpushed work', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt-dirty')]);
    // Unreferenced (no chat) but a merge-conflict / local-only worktree → must be left alone.
    dirtyMock.mockResolvedValue(true);

    const { removed, skipped } = await recoverOrphanedWorktrees(db, '');

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removed).toBe(0);
    expect(skipped).toBe(1);
  });

  it('never removes a registered project root when Frink runs from a linked worktree', async () => {
    await createProject(db, { name: 'P', path: '/repo/qavis-checkout' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/qavis-checkout'),
      wt('/repo/wt-orphan', { branch: 'bo' }),
    ]);

    const { removed, skipped } = await recoverOrphanedWorktrees(db, '');

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo/qavis-checkout', '/repo/wt-orphan', {
      branch: 'bo',
    });
    expect(removed).toBe(1);
    expect(skipped).toBe(0);
  });

  it('is a no-op when there is no drift', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    await createChat(db, { name: 'k', projectId: project.id, worktreePath: '/repo/wt' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt')]);

    const { pruned, removed } = await recoverOrphanedWorktrees(db, '');
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(pruned).toBe(0);
    expect(removed).toBe(0);
  });

  it('reclaims a git-forgotten orphan dir under the injected base and reports the count', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([]); // git no longer lists the leftover dir
    const base = mkTmpBase();
    mkdirp(base, 'frink', 'territorial-solstice', '.husky'); // the real bug shape: no .git

    const { orphaned } = await recoverOrphanedWorktrees(db, base);

    expect(orphaned).toBe(1);
    expect(existsSync(join(base, 'frink', 'territorial-solstice'))).toBe(false);
    expect(existsSync(join(base, 'frink'))).toBe(false); // emptied slug reclaimed too
  });

  it('skips the sweep entirely when given an unresolved base', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    const { orphaned } = await recoverOrphanedWorktrees(db, '');
    expect(orphaned).toBe(0);
  });

  it('does not sweep a worktree git still lists, even with no .git on disk (knownGitPaths wiring)', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    const base = mkTmpBase();
    const known = mkdirp(base, 'frink', 'known-wt'); // on disk, no .git, but git reports it
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt(known)]);
    dirtyMock.mockResolvedValue(true); // git loop skips it (dirty) → isolates the sweep's decision

    const { orphaned, skipped } = await recoverOrphanedWorktrees(db, base);

    expect(orphaned).toBe(0); // threaded into knownGitPaths → never swept
    expect(skipped).toBe(1);
    expect(existsSync(known)).toBe(true);
  });
});

describe('hasLiveGitLinkage', () => {
  it('keeps a worktree whose .git file points at an existing gitdir (clean-canyon shape)', () => {
    const base = mkTmpBase();
    const wt = mkdirp(base, 'wt');
    const target = mkdirp(base, 'repo', '.git', 'worktrees', 'wt');
    writeFileSync(join(wt, '.git'), `gitdir: ${target}\n`);
    expect(hasLiveGitLinkage(wt)).toBe(true);
  });

  it('condemns a .git file whose gitdir target is gone (pruned-but-undeleted)', () => {
    const base = mkTmpBase();
    const wt = mkdirp(base, 'wt');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(base, 'repo', '.git', 'worktrees', 'gone')}\n`);
    expect(hasLiveGitLinkage(wt)).toBe(false);
  });

  it('keeps a worktree whose .git file uses a relative gitdir (real git output shape)', () => {
    const base = mkTmpBase();
    const wt = mkdirp(base, 'slug', 'wt');
    mkdirp(base, 'repo', '.git', 'worktrees', 'wt'); // target, reachable from wt via ../../
    writeFileSync(join(wt, '.git'), 'gitdir: ../../repo/.git/worktrees/wt\n');
    expect(hasLiveGitLinkage(wt)).toBe(true);
  });

  it('condemns a .git file with no gitdir line (truncated/garbage)', () => {
    const base = mkTmpBase();
    const wt = mkdirp(base, 'wt');
    writeFileSync(join(wt, '.git'), 'this file is corrupt\n');
    expect(hasLiveGitLinkage(wt)).toBe(false);
  });

  it('condemns a dead stub with no .git (territorial-solstice shape)', () => {
    const base = mkTmpBase();
    mkdirp(base, 'wt', '.husky');
    expect(hasLiveGitLinkage(join(base, 'wt'))).toBe(false);
  });

  it('keeps a dir whose .git is a directory (embedded repo)', () => {
    const base = mkTmpBase();
    mkdirp(base, 'wt', '.git');
    expect(hasLiveGitLinkage(join(base, 'wt'))).toBe(true);
  });
});

describe('sweepOrphanWorktreeDirs', () => {
  it('removes dead stubs, keeps live/known/referenced + config.json, rmdirs emptied slugs', async () => {
    const base = mkTmpBase();
    writeFileSync(join(base, 'config.json'), '{}'); // depth-1 file must survive
    mkdirp(base, 'proj', 'orphan-stub', '.husky'); // no .git → remove
    const live = mkdirp(base, 'proj', 'live-wt');
    const target = mkdirp(mkTmpBase(), 'gitdir-target'); // outside base so the sweep can't touch it
    writeFileSync(join(live, '.git'), `gitdir: ${target}\n`); // valid linkage → keep
    mkdirp(base, 'proj', 'known-wt'); // in knownGitPaths → keep
    mkdirp(base, 'proj', 'referenced-wt'); // referenced by a live chat → keep
    mkdirp(base, 'gone-proj', 'lone-orphan'); // no .git → remove, then slug becomes empty

    const known = new Set([join(base, 'proj', 'known-wt')]);
    const referenced = new Set([join(base, 'proj', 'referenced-wt')]);
    const removed = await sweepOrphanWorktreeDirs(base, known, referenced);

    expect(removed).toBe(2);
    expect(existsSync(join(base, 'config.json'))).toBe(true);
    expect(existsSync(join(base, 'proj', 'orphan-stub'))).toBe(false);
    expect(existsSync(join(base, 'proj', 'live-wt'))).toBe(true);
    expect(existsSync(join(base, 'proj', 'known-wt'))).toBe(true);
    expect(existsSync(join(base, 'proj', 'referenced-wt'))).toBe(true);
    expect(existsSync(join(base, 'proj'))).toBe(true); // still holds live worktrees → kept
    expect(existsSync(join(base, 'gone-proj'))).toBe(false); // emptied slug reclaimed
  });

  it('never removes an orphan-shaped dir a live chat still references', async () => {
    const base = mkTmpBase();
    const wt = join(base, 'proj', 'wt');
    mkdirp(base, 'proj', 'wt', '.husky'); // dead-stub shape, but referenced
    const removed = await sweepOrphanWorktreeDirs(base, new Set(), new Set([wt]));
    expect(removed).toBe(0);
    expect(existsSync(wt)).toBe(true);
  });

  it('is a no-op for an unresolved or missing base (never scans /)', async () => {
    expect(await sweepOrphanWorktreeDirs('', new Set(), new Set())).toBe(0);
    const missing = join(tmpdir(), 'frink-wt-sweep-does-not-exist-xyz');
    expect(await sweepOrphanWorktreeDirs(missing, new Set(), new Set())).toBe(0);
  });

  // Root ignores POSIX perms and Windows has no equivalent → the EACCES can't be staged there.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips an unremovable orphan (EACCES) without aborting the rest of the batch',
    async () => {
      const base = mkTmpBase();
      const lockedSlug = mkdirp(base, 'locked');
      mkdirp(base, 'locked', 'orphan', '.husky'); // dead stub we make unremovable
      mkdirp(base, 'open', 'orphan', '.husky'); // dead stub that must still be reclaimed
      chmodSync(lockedSlug, 0o500); // r-x, no write → unlinking its child throws EACCES
      try {
        const removed = await sweepOrphanWorktreeDirs(base, new Set(), new Set());
        expect(removed).toBe(1); // the reachable orphan is still reclaimed
        expect(existsSync(join(base, 'open', 'orphan'))).toBe(false);
        expect(existsSync(join(base, 'locked', 'orphan'))).toBe(true); // left for next boot
      } finally {
        chmodSync(lockedSlug, 0o700); // restore so afterEach cleanup can remove it
      }
    },
  );
});
