/**
 * The resolver is the single policy point for "where does a chat land on move?": explicit
 * override → restore from history (if dir still exists) → project root. Tests cover the
 * three branches plus the stale-entry pruning behavior the helper relies on for the next
 * mutation to write a pruned history.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const getDefaultBranchMock = vi.fn();
const detectBaseBranchMock = vi.fn();

vi.mock('node:fs', () => ({ default: { existsSync: existsSyncMock } }));
vi.mock('./worktree', () => ({
  getCurrentBranch: getCurrentBranchMock,
  getDefaultBranch: getDefaultBranchMock,
  detectBaseBranch: detectBaseBranchMock,
}));

const { resolveTargetWorktreeForMove } = await import('./resolve-target-worktree');

describe('resolveTargetWorktreeForMove', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    getCurrentBranchMock.mockReset();
    getDefaultBranchMock.mockReset();
    detectBaseBranchMock.mockReset();
  });

  it('uses explicit override verbatim and re-derives branch from disk (MCP `worktree_path` arg)', async () => {
    getCurrentBranchMock.mockResolvedValue('feat-x');
    getDefaultBranchMock.mockResolvedValue('main');
    detectBaseBranchMock.mockResolvedValue('main');

    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p2',
      targetProjectPath: '/proj/b',
      explicitWorktreePath: '/wt/feat-x',
      history: { p2: '/wt/old' },
    });

    expect(out.worktreePath).toBe('/wt/feat-x');
    expect(out.branch).toBe('feat-x');
    expect(out.baseBranch).toBe('main');
    // Explicit override does not consult history.
    expect(out.stalePrunedProjectId).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('restores the historical worktree when the dir still exists', async () => {
    existsSyncMock.mockReturnValue(true);
    getCurrentBranchMock.mockResolvedValue('feat-prev');
    getDefaultBranchMock.mockResolvedValue('main');
    detectBaseBranchMock.mockResolvedValue('main');

    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p1',
      targetProjectPath: '/proj/a',
      explicitWorktreePath: null,
      history: { p1: '/wt/feat-prev' },
    });

    expect(out.worktreePath).toBe('/wt/feat-prev');
    expect(out.branch).toBe('feat-prev');
    expect(out.baseBranch).toBe('main');
    expect(out.stalePrunedProjectId).toBeNull();
  });

  it('prunes the entry and falls back to project root when the historical dir is gone', async () => {
    existsSyncMock.mockReturnValue(false);

    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p1',
      targetProjectPath: '/proj/a',
      explicitWorktreePath: null,
      history: { p1: '/wt/stale', p2: '/wt/keep' },
    });

    expect(out.worktreePath).toBe('/proj/a');
    expect(out.branch).toBeNull();
    expect(out.baseBranch).toBeNull();
    // Stale projectId flagged so the helper drops it INSIDE its transaction (avoiding the
    // TOCTOU race a pre-pruned-snapshot would create with a concurrent move).
    expect(out.stalePrunedProjectId).toBe('p1');
    // Git helpers never called when falling back.
    expect(getCurrentBranchMock).not.toHaveBeenCalled();
  });

  it('falls back to project root with null branch when no history entry exists', async () => {
    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p3',
      targetProjectPath: '/proj/c',
      explicitWorktreePath: null,
      history: { p1: '/wt/a', p2: '/wt/b' },
    });

    expect(out.worktreePath).toBe('/proj/c');
    expect(out.branch).toBeNull();
    expect(out.baseBranch).toBeNull();
    expect(out.stalePrunedProjectId).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('treats a history entry equal to the project path as no-op (skips restore + leaves history)', async () => {
    // A non-worktree chat moved A→B stores `{A: A.path}`. Restore-to-root would be redundant;
    // the resolver short-circuits without calling fs.existsSync or the git helpers.
    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p1',
      targetProjectPath: '/proj/a',
      explicitWorktreePath: null,
      history: { p1: '/proj/a' },
    });

    expect(out.worktreePath).toBe('/proj/a');
    expect(out.branch).toBeNull();
    expect(out.stalePrunedProjectId).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('returns no worktree for a move to General Chats (null targetProjectId)', async () => {
    const out = await resolveTargetWorktreeForMove({
      targetProjectId: null,
      targetProjectPath: null,
      explicitWorktreePath: null,
      history: { p1: '/wt/a' },
    });

    expect(out.worktreePath).toBeNull();
    expect(out.branch).toBeNull();
    expect(out.stalePrunedProjectId).toBeNull();
  });

  it('gracefully nulls branch when git helpers throw on the restored worktree', async () => {
    existsSyncMock.mockReturnValue(true);
    getCurrentBranchMock.mockRejectedValue(new Error('git missing'));

    const out = await resolveTargetWorktreeForMove({
      targetProjectId: 'p1',
      targetProjectPath: '/proj/a',
      explicitWorktreePath: null,
      history: { p1: '/wt/feat-x' },
    });

    expect(out.worktreePath).toBe('/wt/feat-x');
    expect(out.branch).toBeNull();
    expect(out.baseBranch).toBeNull();
  });
});
