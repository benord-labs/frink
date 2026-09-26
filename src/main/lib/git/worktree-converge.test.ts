/**
 * Unit tests for worktree-converge.ts (sc-612 converging merge strategy).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks set up before module imports
const execFileMock = vi.hoisted(() => vi.fn());
const withGitLockMock = vi.hoisted(() => vi.fn());
const buildChatWorktreePathMock = vi.hoisted(() => vi.fn());
const createWorktreeMock = vi.hoisted(() => vi.fn());
const generateBranchNameMock = vi.hoisted(() => vi.fn());
const getGitEnvMock = vi.hoisted(() => vi.fn());

// Mock node:child_process at the callback level; real promisify wraps it into async.
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('./git-factory', () => ({
  withGitLock: withGitLockMock,
}));
vi.mock('./worktree', () => ({
  buildChatWorktreePath: buildChatWorktreePathMock,
  createWorktree: createWorktreeMock,
  generateBranchName: generateBranchNameMock,
}));
vi.mock('./shell-env', () => ({
  getGitEnv: getGitEnvMock,
}));

import { createWorktreeWithMergedBases } from './worktree-converge';

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
  // withGitLock: run the operation inline
  withGitLockMock.mockImplementation((_path: string, fn: () => Promise<unknown>) => fn());
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
  });
});
