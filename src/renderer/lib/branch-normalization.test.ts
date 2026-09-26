import { describe, expect, it } from 'vitest';
import {
  normalizeCheckedOutBranches,
  normalizeLocalBranches,
  normalizeRemoteBranches,
  transformBranchData,
} from './branch-normalization';

describe('branch-normalization', () => {
  it('normalizes malformed local and remote payloads safely', () => {
    expect(normalizeLocalBranches(undefined)).toEqual([]);
    expect(normalizeRemoteBranches({})).toEqual([]);
    expect(normalizeCheckedOutBranches('bad')).toEqual({});
    expect(
      normalizeLocalBranches([{ bad: true }, { branch: 'main', lastCommitDate: 123 }]),
    ).toEqual([{ branch: 'main', lastCommitDate: 123 }]);
  });

  it('transforms and sorts branches with default/local priority', () => {
    const result = transformBranchData({
      local: [
        { branch: 'feature/z', lastCommitDate: 0 },
        { branch: 'main', lastCommitDate: 1 },
      ],
      remote: ['origin-main', 'feature/remote'],
      defaultBranch: 'main',
      checkedOutBranches: {
        'feature/z': '/tmp/worktrees/feature-z',
      },
    });

    expect(result[0]?.name).toBe('main');
    expect(result[0]?.type).toBe('local');
    expect(result.some((b) => b.name === 'feature/remote' && b.type === 'remote')).toBe(true);
    expect(result.find((b) => b.name === 'feature/z')?.checkedOutIn).toBe(
      '/tmp/worktrees/feature-z',
    );
    expect(result.find((b) => b.name === 'feature/remote')?.checkedOutIn).toBeNull();
  });
});
