import { describe, expect, it } from 'vitest';
import { getMatchedWorktreeBasePath } from './path-matcher';

describe('getMatchedWorktreeBasePath', () => {
  const configured = '/Volumes/dev/worktrees';
  const legacy = '/Users/test/.frink/worktrees';

  it('matches configured custom base path', () => {
    expect(
      getMatchedWorktreeBasePath(
        '/Volumes/dev/worktrees/project-a/misty-ridge/src/index.ts',
        configured,
        legacy,
      ),
    ).toBe(configured);
  });

  it('matches legacy default worktree base path', () => {
    expect(
      getMatchedWorktreeBasePath(
        '/Users/test/.frink/worktrees/project-a/misty-ridge/src/index.ts',
        configured,
        legacy,
      ),
    ).toBe(legacy);
  });

  it('returns null for non-worktree paths', () => {
    expect(
      getMatchedWorktreeBasePath('/Users/test/project/src/index.ts', configured, legacy),
    ).toBeNull();
  });

  it('returns null when candidate base is root-like', () => {
    expect(getMatchedWorktreeBasePath('/Users/test/project/src/index.ts', '/', legacy)).toBeNull();
  });

  it('returns null when candidate base is windows drive root-like', () => {
    expect(getMatchedWorktreeBasePath('C:/repo/src/index.ts', 'C:/', legacy)).toBeNull();
  });

  it('ignores root-like candidate when another valid candidate exists', () => {
    expect(
      getMatchedWorktreeBasePath(
        '/Users/test/.frink/worktrees/project-a/misty-ridge/src/index.ts',
        '/',
        legacy,
      ),
    ).toBe(legacy);
  });
});
