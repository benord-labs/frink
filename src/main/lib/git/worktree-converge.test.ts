/**
 * Unit tests for worktree-converge.ts (sc-612 converging merge strategy).
 */

import type { ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks set up before module imports
const execFileMock = vi.hoisted(() => vi.fn());
const withGitLockMock = vi.hoisted(() => vi.fn());
const buildChatWorktreePathMock = vi.hoisted(() => vi.fn());
const createWorktreeMock = vi.hoisted(() => vi.fn());
const generateBranchNameMock = vi.hoisted(() => vi.fn());
const getGitEnvMock = vi.hoisted(() => vi.fn());
const removeWorktreeMock = vi.hoisted(() => vi.fn());

// Mock node:child_process at the callback level; real promisify wraps it into async.
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  exec: vi.fn(),
}));

vi.mock('./git-factory', () => ({
  withGitLock: withGitLockMock,
}));
vi.mock('./worktree', () => ({
  buildChatWorktreePath: buildChatWorktreePathMock,
  createWorktree: createWorktreeMock,
  generateBranchName: generateBranchNameMock,
  removeWorktree: removeWorktreeMock,
}));
vi.mock('./shell-env', () => ({
  getGitEnv: getGitEnvMock,
}));

import log from 'electron-log';
import * as worktreeConfig from './worktree-config';
import { createWorktreeWithMergedBases } from './worktree-converge';

const awaitWorktreeSetupMock = vi.spyOn(worktreeConfig, 'awaitWorktreeSetup');

const PROJECT_PATH = '/home/user/repo';
const PROJECT_SLUG = 'myproject';
const WORKTREE_PATH = '/home/user/.frink/worktrees/myproject/brave-lion-aabbcc';
const BRANCH_NAME = 'brave-lion-aabbcc';

type CbFn = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

// git commands use 'git -C <path> <sub>' form: ['-C', path, subcommand, ...]
const isGitVersion = (args: string[]) => args[0] === '--version';
const isGitFetch = (args: string[]) => args.includes('fetch');
const isGitMergeTree = (args: string[]) => args.includes('merge-tree');
const isGitMergeAbort = (args: string[]) => args.includes('merge') && args.includes('--abort');
const isGitMerge = (args: string[]) =>
  args.includes('merge') && !args.includes('--abort') && !args.includes('merge-tree');
const isGitDiff = (args: string[]) => args.includes('diff');

function setupCommonMocks() {
  getGitEnvMock.mockResolvedValue({ PATH: '/usr/bin' });
  generateBranchNameMock.mockReturnValue(BRANCH_NAME);
  buildChatWorktreePathMock.mockResolvedValue({ worktreePath: WORKTREE_PATH });
  createWorktreeMock.mockResolvedValue(undefined);
  removeWorktreeMock.mockResolvedValue({ success: true });
  awaitWorktreeSetupMock.mockResolvedValue(null);
  // withGitLock: run the operation inline
  withGitLockMock.mockImplementation((_path: string, fn: () => Promise<unknown>) => fn());
}

function mockCleanMergeGit() {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: ExecFileOptions, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      if (isGitFetch(args) || isGitMergeTree(args) || isGitMerge(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`Unexpected git call: ${args.join(' ')}`));
    },
  );
}

describe('createWorktreeWithMergedBases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  it('clean merge (Git >= 2.38): creates worktree from primary base and merges additional branch', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      if (isGitFetch(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      // merge-tree dry run — clean (just tree SHA, no CONFLICT lines)
      if (isGitMergeTree(args)) {
        cb(null, { stdout: 'abc123def456\n', stderr: '' });
        return;
      }
      // real merge
      if (isGitMerge(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`Unexpected git call: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/ticket-2',
      'feat/ticket-1',
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.baseBranch).toBe('feat/ticket-2');
    expect(result.branch).toBe(BRANCH_NAME);
    expect(result.worktreePath).toBe(WORKTREE_PATH);
    expect(result.mergedBranches).toEqual(['feat/ticket-1']);
  });

  it('merge conflict (Git >= 2.38): returns conflict result without dirtying worktree', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      if (isGitFetch(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      if (isGitMergeTree(args)) {
        // Non-zero exit → conflict
        const err = Object.assign(new Error('conflicts'), {
          code: 1,
          stdout:
            'abc123\nCONFLICT (content): Merge conflict in src/index.ts\nCONFLICT (content): Merge conflict in src/utils.ts\n',
        });
        cb(err as Error);
        return;
      }
      cb(new Error(`Unexpected git call: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/ticket-2',
      'feat/ticket-1',
    ]);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect('conflict' in result).toBe(true);
    if (!('conflict' in result)) return;
    expect(result.conflictingBranch).toBe('feat/ticket-1');
    expect(result.conflictedFiles).toContain('src/index.ts');
    expect(result.conflictedFiles).toContain('src/utils.ts');
    expect(result.mergedBranches).toEqual([]);
    expect(awaitWorktreeSetupMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('3+ branches: first additional merges cleanly, later merge-tree conflict preserves prior mergedBranches', async () => {
    let mergeTreeInvocation = 0;

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      if (isGitFetch(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      if (isGitMergeTree(args)) {
        mergeTreeInvocation += 1;
        // First additional branch: dry-run clean
        if (mergeTreeInvocation === 1) {
          cb(null, { stdout: 'clean-tree-sha-1\n', stderr: '' });
          return;
        }
        // Second additional branch: dry-run reports conflicts
        const err = Object.assign(new Error('conflicts'), {
          code: 1,
          stdout:
            'abc123\nCONFLICT (content): Merge conflict in src/first-wave.ts\nCONFLICT (content): Merge conflict in src/second-wave.ts\n',
        });
        cb(err as Error);
        return;
      }
      // Real merge only runs for the first additional branch (dry-run passed)
      if (isGitMerge(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`Unexpected git call: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/primary',
      'feat/merged-first',
      'feat/conflict-second',
    ]);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect('conflict' in result).toBe(true);
    if (!('conflict' in result)) return;
    expect(result.conflictingBranch).toBe('feat/conflict-second');
    expect(result.conflictedFiles).toContain('src/first-wave.ts');
    expect(result.conflictedFiles).toContain('src/second-wave.ts');
    expect(result.mergedBranches).toEqual(['feat/merged-first']);
  });

  it('fetch failure for additional branch: returns dependency_branch_not_found error', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      // primary base fetch succeeds
      if (isGitFetch(args) && args.includes('feat/ticket-2')) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      // additional base fetch fails
      if (isGitFetch(args) && args.includes('feat/ticket-1')) {
        cb(new Error('fatal: unable to find remote ref feat/ticket-1'));
        return;
      }
      cb(new Error(`Unexpected: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/ticket-2',
      'feat/ticket-1',
    ]);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect('conflict' in result).toBe(false);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('dependency_branch_not_found');
      expect(result.error).toContain('feat/ticket-1');
    }
    expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH, {
      branch: BRANCH_NAME,
    });
  });

  it('Git < 2.38 fallback: uses real merge + abort on conflict', async () => {
    const mergeAbortCalled = { value: false };

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.37.4', stderr: '' });
        return;
      }
      if (isGitFetch(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      // real merge fails
      if (isGitMerge(args)) {
        const err = Object.assign(new Error('merge conflict'), { code: 1 });
        cb(err as Error);
        return;
      }
      // git diff to list conflict files
      if (isGitDiff(args)) {
        cb(null, { stdout: 'src/conflict.ts\n', stderr: '' });
        return;
      }
      // git merge --abort
      if (isGitMergeAbort(args)) {
        mergeAbortCalled.value = true;
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`Unexpected: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/ticket-2',
      'feat/ticket-1',
    ]);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect('conflict' in result).toBe(true);
    if (!('conflict' in result)) return;
    expect(result.conflictingBranch).toBe('feat/ticket-1');
    expect(result.conflictedFiles).toContain('src/conflict.ts');
    expect(mergeAbortCalled.value).toBe(true);
  });

  /**
   * Race / stale dry-run (sc-612): merge-tree reports clean but the real merge fails
   * (e.g. branch force-pushed between dry-run and merge). worktree-converge.ts wraps the
   * real merge in try/catch for the in-memory path and returns a structured conflict result
   * (see comments near the real `git merge` in createWorktreeWithMergedBases).
   */
  it('race: merge-tree dry-run passes but real merge fails → returns conflict result (not generic error)', async () => {
    const mergeAbortCalled = { value: false };

    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: CbFn) => {
      if (isGitVersion(args)) {
        cb(null, { stdout: 'git version 2.38.0', stderr: '' });
        return;
      }
      if (isGitFetch(args)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      // merge-tree: reports clean (dry-run passes)
      if (isGitMergeTree(args)) {
        cb(null, { stdout: 'abc123def456\n', stderr: '' });
        return;
      }
      // real merge fails (simulates force-push race — branch changed between dry-run and merge)
      if (isGitMerge(args)) {
        const err = Object.assign(new Error('CONFLICT (content): Merge conflict in src/race.ts'), {
          code: 1,
        });
        cb(err as Error);
        return;
      }
      // git diff --diff-filter=U to detect conflict files
      if (isGitDiff(args)) {
        cb(null, { stdout: 'src/race.ts\n', stderr: '' });
        return;
      }
      // git merge --abort
      if (isGitMergeAbort(args)) {
        mergeAbortCalled.value = true;
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`Unexpected: ${args.join(' ')}`));
    });

    const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, [
      'feat/ticket-2',
      'feat/ticket-1',
    ]);

    // Must return a structured conflict result, not a generic { success: false, error: '...' }
    expect(result.success).toBe(false);
    if (result.success) return;
    expect('conflict' in result).toBe(true);
    if (!('conflict' in result)) return;
    expect(result.conflictingBranch).toBe('feat/ticket-1');
    expect(result.conflictedFiles).toContain('src/race.ts');
    // Worktree must be left clean
    expect(mergeAbortCalled.value).toBe(true);
    expect(awaitWorktreeSetupMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  describe('setup-worktree commands', () => {
    const BRANCHES: [string, string] = ['feat/ticket-2', 'feat/ticket-1'];

    it('runs setup after the merges, with no git lock held', async () => {
      mockCleanMergeGit();
      let locksHeld = 0;
      withGitLockMock.mockImplementation(async <T>(_path: string, fn: () => Promise<T>) => {
        locksHeld += 1;
        try {
          return await fn();
        } finally {
          locksHeld -= 1;
        }
      });
      let locksHeldDuringSetup = -1;
      awaitWorktreeSetupMock.mockImplementation(async () => {
        locksHeldDuringSetup = locksHeld;
        return null;
      });
      const signal = new AbortController().signal;

      const result = await createWorktreeWithMergedBases(
        PROJECT_PATH,
        PROJECT_SLUG,
        BRANCHES,
        signal,
      );

      expect(result.success).toBe(true);
      expect(awaitWorktreeSetupMock).toHaveBeenCalledTimes(1);
      expect(awaitWorktreeSetupMock).toHaveBeenCalledWith(WORKTREE_PATH, PROJECT_PATH, signal);
      expect(locksHeldDuringSetup).toBe(0);
      expect(removeWorktreeMock).not.toHaveBeenCalled();
    });

    it('rolls the worktree and branch back when setup fails', async () => {
      mockCleanMergeGit();
      awaitWorktreeSetupMock.mockResolvedValue('Worktree setup failed: bun install exited 1');

      const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, BRANCHES);

      expect(result).toEqual({
        success: false,
        error: 'Worktree setup failed: bun install exited 1',
      });
      expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH, {
        branch: BRANCH_NAME,
      });
    });

    it('still reports the setup failure, and logs the leftover, when rollback cannot remove the worktree', async () => {
      mockCleanMergeGit();
      awaitWorktreeSetupMock.mockResolvedValue('Worktree setup failed: exit 3');
      removeWorktreeMock.mockResolvedValue({ success: false, error: 'worktree is locked' });
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

      const result = await createWorktreeWithMergedBases(PROJECT_PATH, PROJECT_SLUG, BRANCHES);

      expect(result).toEqual({ success: false, error: 'Worktree setup failed: exit 3' });
      expect(warn).toHaveBeenCalledWith('[worktree-converge] rollback left the worktree behind', {
        worktreePath: WORKTREE_PATH,
        removeError: 'worktree is locked',
      });
      warn.mockRestore();
    });

    // With no setup commands configured, setup reports success without looking at the signal.
    it('rolls back without running setup when the run was cancelled during the merges', async () => {
      mockCleanMergeGit();
      const controller = new AbortController();
      controller.abort();

      const result = await createWorktreeWithMergedBases(
        PROJECT_PATH,
        PROJECT_SLUG,
        BRANCHES,
        controller.signal,
      );

      expect(result).toEqual({ success: false, error: 'Cancelled' });
      expect(awaitWorktreeSetupMock).not.toHaveBeenCalled();
      expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH, {
        branch: BRANCH_NAME,
      });
    });

    // The cancel lands after the last setup command finished, so setup itself reports success.
    it('rolls back when the run is cancelled while setup is finishing', async () => {
      mockCleanMergeGit();
      const controller = new AbortController();
      awaitWorktreeSetupMock.mockImplementation(async () => {
        controller.abort();
        return null;
      });

      const result = await createWorktreeWithMergedBases(
        PROJECT_PATH,
        PROJECT_SLUG,
        BRANCHES,
        controller.signal,
      );

      expect(result).toEqual({ success: false, error: 'Cancelled' });
      expect(removeWorktreeMock).toHaveBeenCalledOnce();
    });

    // A cancelled run discards the conflict result, so no one would ever resolve that worktree.
    it('rolls a conflict worktree back when the run was cancelled', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, args: string[], _opts: ExecFileOptions, cb: CbFn) => {
          if (isGitVersion(args)) {
            cb(null, { stdout: 'git version 2.38.0', stderr: '' });
            return;
          }
          if (isGitFetch(args)) {
            cb(null, { stdout: '', stderr: '' });
            return;
          }
          if (isGitMergeTree(args)) {
            cb(Object.assign(new Error('conflicts'), { code: 1, stdout: 'abc\n' }));
            return;
          }
          cb(new Error(`Unexpected git call: ${args.join(' ')}`));
        },
      );
      const controller = new AbortController();
      controller.abort();

      const result = await createWorktreeWithMergedBases(
        PROJECT_PATH,
        PROJECT_SLUG,
        BRANCHES,
        controller.signal,
      );

      expect(result).toEqual({ success: false, error: 'Cancelled' });
      expect(removeWorktreeMock).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH, {
        branch: BRANCH_NAME,
      });
    });
  });
});
