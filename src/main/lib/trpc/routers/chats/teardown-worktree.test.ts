/** Worktree teardown: tri-state sibling safety, git-only deletion, project-delete dedup, boot recovery, retry predicate. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  hasOtherChatsSharingWorktree: siblingMock,
}));

import { isTransientWorktreeRemoveError } from '../../../git/worktree';
import {
  recoverOrphanedWorktrees,
  removeProjectWorktrees,
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
  siblingMock.mockResolvedValue(false);
});

// Real temp dirs for on-disk worktree shapes — never the developer's real ~/.frink/worktrees.
const tmpBases: string[] = [];
const mkTmpBase = (): string => {
  const base = mkdtempSync(join(tmpdir(), 'frink-wt-'));
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

// Frink deletes a worktree only through git: when git cannot remove one, the folder stays on disk.
describe('tearDownChatWorktree when git cannot remove the worktree', () => {
  it('leaves a worktree whose repo was moved on disk, uncommitted work included', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    siblingMock.mockResolvedValue(false);
    const base = mkTmpBase();
    const dir = mkdirp(base, 'slug', 'wt');
    writeFileSync(
      join(dir, '.git'),
      `gitdir: ${join(base, 'moved-repo', '.git', 'worktrees', 'wt')}\n`,
    );
    const work = join(mkdirp(dir, 'src'), 'uncommitted.ts');
    writeFileSync(work, 'x');
    removeWorktreeMock.mockResolvedValue({ success: false, error: 'fatal: not a git repository' });

    const ok = await tearDownChatWorktree(db, {
      id: 'c1',
      worktreePath: dir,
      branch: 'feat',
      projectId: project.id,
    });

    expect(ok).toBe(false);
    expect(existsSync(work)).toBe(true);
  });
});

// sc-3292: the REAL sibling query must count an archived fork as a holder — removal is --force and
// deletes the branch, so a wrong "no siblings" destroys the fork's unpushed work.
describe('tearDownChatWorktree with the real sibling query', () => {
  const archived = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(async () => {
    const actual =
      await vi.importActual<typeof import('../../../db/repos/chats')>('../../../db/repos/chats');
    siblingMock.mockImplementation(actual.hasOtherChatsSharingWorktree);
  });

  it('keeps the worktree when a deleted chat leaves an archived fork behind', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    // chats.delete removes A's row before teardown runs; only archived fork B remains.
    await createChat(db, {
      id: 'b',
      name: 'B',
      projectId: project.id,
      worktreePath: '/repo/wt',
      branch: 'feat',
      archivedAt: archived,
    });

    const ok = await tearDownChatWorktree(db, {
      id: 'a',
      worktreePath: '/repo/wt',
      branch: 'feat',
      projectId: project.id,
    });

    expect(ok).toBe(false);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('keeps the worktree when archiving with deleteWorktree while an archived fork still holds it', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    const ref = { worktreePath: '/repo/wt', branch: 'feat', projectId: project.id };
    await createChat(db, { id: 'a', name: 'A', ...ref, archivedAt: archived });
    await createChat(db, { id: 'b', name: 'B', ...ref, archivedAt: archived });

    const ok = await tearDownChatWorktree(db, { id: 'b', ...ref });

    expect(ok).toBe(false);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('removes the worktree once the last holder releases it', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    const ref = { worktreePath: '/repo/wt', branch: 'feat', projectId: project.id };
    await createChat(db, { id: 'b', name: 'B', ...ref, archivedAt: archived });

    const ok = await tearDownChatWorktree(db, { id: 'b', ...ref });

    expect(ok).toBe(true);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/wt', { branch: 'feat' });
  });

  it('boot recovery keeps a clean, pushed worktree held only by an archived fork', async () => {
    // Teardown deferred to archived fork B; after a restart B must still own it, else restore
    // points at a missing directory.
    const project = await createProject(db, { name: 'P', path: '/repo' });
    const ref = { worktreePath: '/repo/wt', branch: 'feat', projectId: project.id };
    await createChat(db, { id: 'b', name: 'B', ...ref, archivedAt: archived });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt')]);

    const { removed } = await recoverOrphanedWorktrees(db);

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removed).toBe(0);
  });

  it('boot recovery keeps a worktree a chat starts using after the referenced snapshot', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/wt-race', { branch: 'br' }),
      wt('/repo/wt-gone', { branch: 'bg' }),
    ]);
    managedMock.mockImplementation(async (path: string) => {
      if (path === '/repo/wt-race') {
        await createChat(db, { name: 'late', projectId: project.id, worktreePath: path });
      }
      return true;
    });

    const { removed, skipped } = await recoverOrphanedWorktrees(db);

    expect(removeWorktreeMock.mock.calls).toEqual([['/repo', '/repo/wt-gone', { branch: 'bg' }]]);
    expect(removed).toBe(1);
    expect(skipped).toBe(1);
  });
});

describe('removeProjectWorktrees', () => {
  it('kills every chat terminal and removes each distinct worktree once', async () => {
    await removeProjectWorktrees(db, '/repo', [
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

  it('keeps a worktree a chat in another project still holds after the cascade', async () => {
    const actual =
      await vi.importActual<typeof import('../../../db/repos/chats')>('../../../db/repos/chats');
    siblingMock.mockImplementation(actual.hasOtherChatsSharingWorktree);
    const other = await createProject(db, { name: 'Q', path: '/other' });
    await createChat(db, {
      id: 'survivor',
      name: 'G',
      projectId: other.id,
      worktreePath: '/repo/shared',
      branch: 'bs',
    });

    await removeProjectWorktrees(db, '/repo', [
      { id: 'gone-1', worktreePath: '/repo/shared', branch: 'bs' },
      { id: 'gone-2', worktreePath: '/repo/own', branch: 'bo' },
    ]);

    expect(removeWorktreeMock.mock.calls).toEqual([['/repo', '/repo/own', { branch: 'bo' }]]);
  });

  it('keeps every worktree when the sibling check cannot answer', async () => {
    siblingMock.mockRejectedValue(new Error('SQLITE_BUSY'));

    await removeProjectWorktrees(db, '/repo', [
      { id: 'gone', worktreePath: '/repo/a', branch: 'ba' },
    ]);

    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanedWorktrees', () => {
  it('rechecks positive ownership before deletion when a prefetched marker was revoked', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/revoked')]);
    managedMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await recoverOrphanedWorktrees(db)).skipped).toBe(1);
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

    const result = await recoverOrphanedWorktrees(db);

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 0 });
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

    const { pruned, removed, skipped } = await recoverOrphanedWorktrees(db);

    expect(pruneWorktreesMock).toHaveBeenCalledWith('/repo');
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/repo/wt-orphan', { branch: 'bo' });
    expect(configureHooksMock).toHaveBeenCalledTimes(1);
    expect(configureHooksMock).toHaveBeenCalledWith('/repo', '/repo/wt-keep');
    expect(pruned).toBe(1);
    expect(removed).toBe(1);
    expect(skipped).toBe(0);
  });

  it('never removes a clean pushed manual worktree without Frink ownership', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/manual-dev-worktree'),
    ]);
    managedMock.mockResolvedValue(false);

    const result = await recoverOrphanedWorktrees(db);

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 1 });
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

    const result = await recoverOrphanedWorktrees(db);

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

    const result = await recoverOrphanedWorktrees(db);

    expect(captureContainedMock).toHaveBeenCalledWith(expect.any(Error), {
      surface: 'worktree-ownership',
      stage: 'startup-prefetch',
    });

    expect(result).toEqual({ pruned: 0, removed: 0, skipped: 1 });
    expect(dirtyMock).not.toHaveBeenCalled();
    expect(unpushedMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('never force-deletes an unreferenced worktree that holds uncommitted/unpushed work', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt-dirty')]);
    // Unreferenced (no chat) but a merge-conflict / local-only worktree → must be left alone.
    dirtyMock.mockResolvedValue(true);

    const { removed, skipped } = await recoverOrphanedWorktrees(db);

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removed).toBe(0);
    expect(skipped).toBe(1);
  });

  it('never removes a registered project root when Frink runs from a linked worktree', async () => {
    await createProject(db, { name: 'P', path: '/repo/other-checkout' });
    listWorktreesMock.mockResolvedValue([
      wt('/repo', { isMain: true }),
      wt('/repo/other-checkout'),
      wt('/repo/wt-orphan', { branch: 'bo' }),
    ]);

    const { removed, skipped } = await recoverOrphanedWorktrees(db);

    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo/other-checkout', '/repo/wt-orphan', {
      branch: 'bo',
    });
    expect(removed).toBe(1);
    expect(skipped).toBe(0);
  });

  it('keeps an unreferenced worktree when the pre-removal reference check cannot answer', async () => {
    await createProject(db, { name: 'P', path: '/repo' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt-orphan')]);
    siblingMock.mockRejectedValue(new Error('SQLITE_BUSY'));

    const { removed, skipped } = await recoverOrphanedWorktrees(db);

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect({ removed, skipped }).toEqual({ removed: 0, skipped: 1 });
  });

  it('is a no-op when there is no drift', async () => {
    const project = await createProject(db, { name: 'P', path: '/repo' });
    await createChat(db, { name: 'k', projectId: project.id, worktreePath: '/repo/wt' });
    listWorktreesMock.mockResolvedValue([wt('/repo', { isMain: true }), wt('/repo/wt')]);

    const { pruned, removed } = await recoverOrphanedWorktrees(db);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(pruned).toBe(0);
    expect(removed).toBe(0);
  });
});
