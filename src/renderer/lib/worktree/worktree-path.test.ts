import { describe, expect, it } from 'vitest';
import { extractWorktreeRelativePath } from './worktree-path';

describe('extractWorktreeRelativePath', () => {
  it('extracts relative path from legacy .frink/worktrees paths', () => {
    const filePath =
      '/Users/test/.frink/worktrees/my-project/blue-harbor/src/components/button.tsx';
    expect(extractWorktreeRelativePath(filePath)).toBe('src/components/button.tsx');
  });

  it('extracts relative path from configured custom base path', () => {
    const basePath = '/Volumes/dev/worktrees';
    const filePath = '/Volumes/dev/worktrees/my-project/misty-ridge/src/main.ts';
    expect(extractWorktreeRelativePath(filePath, basePath)).toBe('src/main.ts');
  });

  it('returns null for non-worktree paths', () => {
    expect(extractWorktreeRelativePath('/Users/test/project/src/index.ts')).toBeNull();
  });

  it('does not match everything when configured base is root-like', () => {
    expect(extractWorktreeRelativePath('/Users/test/project/src/index.ts', '/')).toBeNull();
  });

  it('does not match everything when configured base is windows drive root-like', () => {
    expect(extractWorktreeRelativePath('C:/repo/src/index.ts', 'C:/')).toBeNull();
  });
});
