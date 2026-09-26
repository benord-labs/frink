import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('simple-git', () => ({
  default: vi.fn(),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import simpleGit from 'simple-git';
import { applyRollbackStash, createRollbackStash } from './stash';

type MockGit = {
  raw: ReturnType<typeof vi.fn>;
  checkIsRepo: ReturnType<typeof vi.fn>;
  env: ReturnType<typeof vi.fn>;
};

function createMockGit(): MockGit {
  const git: MockGit = {
    raw: vi.fn(),
    checkIsRepo: vi.fn().mockResolvedValue(true),
    env: vi.fn(),
  };
  // env() returns a git-like object for chained calls (temp index)
  git.env.mockReturnValue({ raw: vi.fn().mockResolvedValue('') });
  return git;
}

describe('applyRollbackStash', () => {
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    simpleGitMock.mockReset();
  });

  it('returns checkpointFound false when checkpoint ref is missing', async () => {
    const git = createMockGit();
    git.raw.mockRejectedValueOnce(new Error('not found'));
    simpleGitMock.mockReturnValue(git as never);

    const result = await applyRollbackStash('/tmp/worktree', 'msg-1');

    expect(result).toEqual({ success: true, checkpointFound: false });
  });

  it('returns an error when checkpoint metadata is invalid', async () => {
    const git = createMockGit();
    git.raw.mockResolvedValueOnce('abc123\n');
    git.raw.mockResolvedValueOnce('{}');
    simpleGitMock.mockReturnValue(git as never);

    const result = await applyRollbackStash('/tmp/worktree', 'msg-2');

    expect(result).toEqual({
      success: false,
      error: 'Checkpoint missing tree metadata',
    });
  });

  it('returns checkpointFound true when rollback is applied successfully', async () => {
    const git = createMockGit();
    git.raw.mockResolvedValueOnce('abc123\n');
    git.raw.mockResolvedValueOnce(
      JSON.stringify({
        indexTree: 'index-tree-hash',
        worktreeTree: 'worktree-tree-hash',
      }),
    );
    git.raw.mockResolvedValueOnce('');
    git.raw.mockResolvedValueOnce('');
    git.raw.mockResolvedValueOnce('');
    git.raw.mockResolvedValueOnce('');
    simpleGitMock.mockReturnValue(git as never);

    const result = await applyRollbackStash('/tmp/worktree', 'msg-3');

    expect(result).toEqual({ success: true, checkpointFound: true });
  });
});

describe('createRollbackStash', () => {
  const simpleGitMock = vi.mocked(simpleGit);

  beforeEach(() => {
    simpleGitMock.mockReset();
  });

  it('skips checkpoint creation for non-git directories', async () => {
    const git = createMockGit();
    git.checkIsRepo.mockResolvedValue(false);
    simpleGitMock.mockReturnValue(git as never);

    await createRollbackStash('/Users/someone', 'uuid-1');

    // Should bail after checkIsRepo — no write-tree or update-ref calls
    expect(git.raw).not.toHaveBeenCalled();
  });

  it('creates checkpoint ref when cwd is a valid git repo', async () => {
    const tempGitRaw = vi.fn().mockResolvedValue('worktree-tree-hash\n');
    const git = createMockGit();
    git.checkIsRepo.mockResolvedValue(true);
    git.raw
      .mockResolvedValueOnce('index-tree-hash\n') // write-tree
      .mockResolvedValueOnce('commit-hash-abc\n') // commit-tree
      .mockResolvedValueOnce(''); // update-ref
    git.env.mockReturnValue({ raw: tempGitRaw });
    simpleGitMock.mockReturnValue(git as never);

    await createRollbackStash('/tmp/project', 'uuid-2');

    // Should have called update-ref with the checkpoint path
    expect(git.raw).toHaveBeenCalledWith([
      'update-ref',
      'refs/checkpoints/uuid-2',
      'commit-hash-abc',
    ]);
  });
});
