import { describe, expect, it } from 'vitest';
import type { ParsedDiffFile } from '../../../../shared/changes-types';
import {
  filterDiffFilesByPath,
  findDiffFileByPath,
  getDiffPanelNotice,
  getDiffReadError,
  getPrHandoffState,
  parseRenderableDiffFiles,
  resolveDiffScopePaths,
  toggleAllCollapsed,
  toggleKey,
  withoutKey,
  toCodeViewItems,
} from './diff-code-view-items';

function diffFile(path: string, overrides: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return {
    key: `${path}->${path}`,
    oldPath: path,
    newPath: path,
    diffText: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'),
    isBinary: false,
    additions: 1,
    deletions: 1,
    isValid: true,
    fileLang: null,
    isNewFile: false,
    isDeletedFile: false,
    ...overrides,
  };
}

describe('parseRenderableDiffFiles', () => {
  it('parses each file patch and keys it by the file key', () => {
    const { renderable, unrenderableCount } = parseRenderableDiffFiles([diffFile('src/a.ts')]);
    expect(unrenderableCount).toBe(0);
    expect(renderable).toHaveLength(1);
    expect(renderable[0].key).toBe('src/a.ts->src/a.ts');
    expect(renderable[0].path).toBe('src/a.ts');
    expect(renderable[0].fileDiff.hunks).toHaveLength(1);
  });

  it('counts binary and malformed files as unrenderable instead of rendering them', () => {
    const { renderable, unrenderableCount } = parseRenderableDiffFiles([
      diffFile('logo.png', { isBinary: true }),
      diffFile('broken.ts', { isValid: false }),
      diffFile('ok.ts'),
    ]);
    expect(renderable.map((file) => file.path)).toEqual(['ok.ts']);
    expect(unrenderableCount).toBe(2);
  });

  it('names a deleted file by its old path', () => {
    const { renderable } = parseRenderableDiffFiles([
      diffFile('gone.ts', { newPath: '/dev/null', isDeletedFile: true }),
    ]);
    expect(renderable[0].path).toBe('gone.ts');
  });
});

describe('filterDiffFilesByPath', () => {
  const files = [{ path: 'a.ts' }, { path: 'b.ts' }];

  it('keeps every file when no filter is set', () => {
    expect(filterDiffFilesByPath(files, null)).toBe(files);
  });

  it('keeps only the requested paths', () => {
    expect(filterDiffFilesByPath(files, ['b.ts'])).toEqual([{ path: 'b.ts' }]);
  });
});

describe('toCodeViewItems', () => {
  it('marks collapsed files by key', () => {
    const { renderable } = parseRenderableDiffFiles([diffFile('a.ts'), diffFile('b.ts')]);
    const items = toCodeViewItems(renderable, new Set(['b.ts->b.ts']));
    expect(items.map((item) => [item.id, item.collapsed])).toEqual([
      ['a.ts->a.ts', false],
      ['b.ts->b.ts', true],
    ]);
  });

  it('publishes a new version when a file collapses or expands', () => {
    const { renderable } = parseRenderableDiffFiles([diffFile('a.ts')]);
    const [expanded] = toCodeViewItems(renderable, new Set());
    const [collapsed] = toCodeViewItems(renderable, new Set(['a.ts->a.ts']));
    expect(collapsed.version).not.toBe(expanded.version);
  });

  it('publishes a new version when a file changes, and keeps it when it does not', () => {
    const original = diffFile('a.ts');
    const edited = diffFile('a.ts', { diffText: original.diffText.replace('+new', '+newer') });
    const version = (file: ParsedDiffFile) =>
      toCodeViewItems(parseRenderableDiffFiles([file]).renderable, new Set())[0].version;
    expect(version(original)).toBe(version(original));
    expect(version(edited)).not.toBe(version(original));
  });
});

describe('findDiffFileByPath', () => {
  const files = [{ path: 'src/a.ts' }, { path: 'lib/a.ts' }];

  it('prefers an exact relative match', () => {
    expect(findDiffFileByPath(files, 'lib/a.ts')).toBe(files[1]);
  });

  it('matches an absolute path by its worktree-relative suffix', () => {
    expect(findDiffFileByPath(files, '/repo/wt/src/a.ts')).toBe(files[0]);
  });

  it('prefers the longest path when several files end the target path', () => {
    const nested = [{ path: 'a.ts' }, { path: 'src/a.ts' }];
    expect(findDiffFileByPath(nested, '/repo/src/a.ts')).toBe(nested[1]);
  });

  it('matches a Windows absolute path', () => {
    expect(findDiffFileByPath(files, 'C:\\repo\\src\\a.ts')).toBe(files[0]);
  });

  it('does not match a path that only shares a file name', () => {
    expect(findDiffFileByPath(files, '/repo/wt/other/a.ts')).toBeUndefined();
  });
});

describe('getDiffPanelNotice', () => {
  const base = { isLoading: false, error: null, hasChanges: true };

  it('shows nothing when there are files to render', () => {
    expect(getDiffPanelNotice(base)).toBeNull();
  });

  it('explains a folder that is not a git repository in plain words', () => {
    expect(
      getDiffPanelNotice({ ...base, error: 'fatal: not a git repository (or any parent)' }),
    ).toContain("isn't tracked by git");
  });

  it('does not mistake a folder path containing the phrase for a missing repository', () => {
    const error = "fatal: cannot change to '/work/not a git repository/app': No such file";
    expect(getDiffPanelNotice({ ...base, error })).toContain('reopen');
  });

  it('gives a retry hint for any other read failure', () => {
    expect(getDiffPanelNotice({ ...base, error: 'spawn git ENOENT' })).toContain('reopen');
  });

  it('says the panel is empty when nothing changed', () => {
    expect(getDiffPanelNotice({ ...base, hasChanges: false })).toContain('No uncommitted changes');
  });
});

describe('resolveDiffScopePaths', () => {
  it('prefers an explicit file list over the sub-chat files', () => {
    expect(resolveDiffScopePaths(['a.ts'], [{ displayPath: 'b.ts' }])).toEqual(['a.ts']);
  });

  it('falls back to the sub-chat files, then to no filter', () => {
    expect(resolveDiffScopePaths(null, [{ displayPath: 'b.ts' }])).toEqual(['b.ts']);
    expect(resolveDiffScopePaths(null, undefined)).toBeNull();
  });
});

describe('toggleKey', () => {
  it('adds a missing key and removes a present one without mutating the input', () => {
    const keys = new Set(['a']);
    expect([...toggleKey(keys, 'b')]).toEqual(['a', 'b']);
    expect([...toggleKey(keys, 'a')]).toEqual([]);
    expect([...keys]).toEqual(['a']);
  });
});

describe('withoutKey', () => {
  it('returns the same set when the key is absent', () => {
    const keys = new Set(['a']);
    expect(withoutKey(keys, 'b')).toBe(keys);
    expect([...withoutKey(keys, 'a')]).toEqual([]);
  });
});

describe('toggleAllCollapsed', () => {
  it('collapses every file, then expands them all', () => {
    const collapsed = toggleAllCollapsed(new Set(), ['a', 'b']);
    expect([...collapsed]).toEqual(['a', 'b']);
    expect([...toggleAllCollapsed(collapsed, ['a', 'b'])]).toEqual([]);
  });

  it('treats an empty list as not collapsed', () => {
    expect([...toggleAllCollapsed(new Set(), [])]).toEqual([]);
  });
});

describe('getDiffReadError', () => {
  it('is null for a successful read', () => {
    expect(getDiffReadError({ totalAdditions: 0 }, null)).toBeNull();
  });

  it('treats an empty error string as a failed read, not as no changes', () => {
    expect(getDiffReadError({ totalAdditions: 0, error: '' }, null)).toBe(
      'The changes could not be read.',
    );
  });

  it('keeps the server or transport message', () => {
    expect(
      getDiffReadError({ totalAdditions: 0, error: 'fatal: not a git repository' }, null),
    ).toBe('fatal: not a git repository');
    expect(getDiffReadError(undefined, { message: 'offline' })).toBe('offline');
  });
});

describe('getPrHandoffState', () => {
  it('offers nothing PR-specific without an open PR', () => {
    expect(getPrHandoffState(null, true)).toEqual({
      isPrKnown: true,
      isPrOpen: false,
      hasMergeConflicts: false,
    });
    expect(getPrHandoffState({ state: 'merged', mergeable: 'CONFLICTING' }, true).isPrOpen).toBe(
      false,
    );
  });

  it('treats a draft as open and reports conflicts', () => {
    expect(getPrHandoffState({ state: 'draft', mergeable: 'CONFLICTING' }, true)).toEqual({
      isPrKnown: true,
      isPrOpen: true,
      hasMergeConflicts: true,
    });
  });

  it('claims nothing while the status is loading or failed', () => {
    expect(getPrHandoffState(null, false)).toEqual({
      isPrKnown: false,
      isPrOpen: false,
      hasMergeConflicts: false,
    });
  });
});
