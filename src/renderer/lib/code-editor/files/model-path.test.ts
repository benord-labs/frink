import { describe, expect, it } from 'vitest';
import { buildFileModelPath, getFullPath } from './model-path';

describe('model path helpers', () => {
  it('joins relative paths to project path', () => {
    expect(getFullPath('/repo/worktree', 'src/index.ts')).toBe('/repo/worktree/src/index.ts');
  });

  it('preserves already-absolute paths', () => {
    expect(getFullPath('/repo/worktree', '/repo/other/a.ts')).toBe('/repo/other/a.ts');
  });

  it('preserves Windows absolute paths instead of joining them onto the project', () => {
    expect(getFullPath('C:\\repo', 'C:\\outside\\a.ts')).toBe('C:\\outside\\a.ts');
    expect(getFullPath('C:\\repo', '\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
  });

  it('encodes reserved uri characters in model path', () => {
    expect(buildFileModelPath('/repo/worktree', 'src/a #b?.ts')).toBe(
      'file:///repo/worktree/src/a%20#b?.ts',
    );
  });

  it('keeps path separators while encoding spaces/unicode', () => {
    expect(buildFileModelPath('/repo/worktree', 'src/folder with space/naïve.ts')).toBe(
      'file:///repo/worktree/src/folder%20with%20space/na%C3%AFve.ts',
    );
  });
});
