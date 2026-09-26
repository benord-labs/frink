import { beforeEach, describe, expect, it } from 'vitest';
import { gitCache } from './git-cache';

describe('gitCache file-content invalidation', () => {
  beforeEach(() => {
    gitCache.clearAll();
  });

  it('normalizes worktree and file path when invalidating by file prefix', () => {
    gitCache.setFileContent('/repo/worktree', 'src/foo.ts:working:', 'one');
    gitCache.setFileContent('/repo/worktree', 'src/foo.ts:staged:abc123', 'two');
    gitCache.setFileContent('/repo/worktree', 'src/foo.tsx:working:', 'three');
    gitCache.setFileContent('/repo/worktree', 'src/bar.ts:working:', 'four');
    gitCache.setFileContent('/repo/other', 'src/foo.ts:working:', 'five');

    const invalidated = gitCache.invalidateFileContentsByPath('/repo\\worktree', 'src\\foo.ts');
    expect(invalidated).toBe(2);

    expect(gitCache.getFileContent('/repo/worktree', 'src/foo.ts:working:')).toBeNull();
    expect(gitCache.getFileContent('/repo/worktree', 'src/foo.ts:staged:abc123')).toBeNull();
    expect(gitCache.getFileContent('/repo/worktree', 'src/foo.tsx:working:')).toBe('three');
    expect(gitCache.getFileContent('/repo/worktree', 'src/bar.ts:working:')).toBe('four');
    expect(gitCache.getFileContent('/repo/other', 'src/foo.ts:working:')).toBe('five');
  });
});
