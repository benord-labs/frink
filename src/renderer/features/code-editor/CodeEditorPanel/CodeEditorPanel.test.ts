import { describe, expect, it } from 'vitest';
import {
  canAutoRefreshFromExternalChange,
  isGitPointerPath,
  normalizePath,
  shouldApplyExternalRefreshResult,
  shouldScheduleExternalRefresh,
} from '@/lib/code-editor/files';
import {
  getInlineDiffState,
  isInlineDiffToggleShortcut,
  shouldAutoEnableInlineDiff,
} from '@/lib/code-editor/inline-diff';

describe('CodeEditorPanel external refresh helpers', () => {
  it('normalizes windows path separators', () => {
    expect(normalizePath('C:\\repo\\src\\index.ts')).toBe('C:/repo/src/index.ts');
  });

  it('detects git pointer paths', () => {
    expect(isGitPointerPath('/repo/.git/HEAD')).toBe(true);
    expect(isGitPointerPath('/repo/.git/index')).toBe(true);
    expect(isGitPointerPath('/repo/.git/refs/heads/main')).toBe(true);
    expect(isGitPointerPath('/repo/.git/packed-refs')).toBe(true);
    expect(isGitPointerPath('/repo/.git/refs/remotes/origin/main')).toBe(true);
    expect(isGitPointerPath('/repo/src/index.ts')).toBe(false);
  });

  it('only auto-refreshes clean loaded text files', () => {
    expect(
      canAutoRefreshFromExternalChange({
        isDirty: false,
        hasContent: true,
        hasLoadError: false,
        isTextEditorFile: true,
      }),
    ).toBe(true);

    expect(
      canAutoRefreshFromExternalChange({
        isDirty: true,
        hasContent: true,
        hasLoadError: false,
        isTextEditorFile: true,
      }),
    ).toBe(false);

    expect(
      canAutoRefreshFromExternalChange({
        isDirty: false,
        hasContent: false,
        hasLoadError: false,
        isTextEditorFile: true,
      }),
    ).toBe(false);

    expect(
      canAutoRefreshFromExternalChange({
        isDirty: false,
        hasContent: true,
        hasLoadError: true,
        isTextEditorFile: true,
      }),
    ).toBe(false);

    expect(
      canAutoRefreshFromExternalChange({
        isDirty: false,
        hasContent: true,
        hasLoadError: false,
        isTextEditorFile: false,
      }),
    ).toBe(false);
  });

  it('schedules refresh only for matching worktree and relevant git/file changes', () => {
    expect(
      shouldScheduleExternalRefresh({
        watchedWorktreePath: '/repo/a',
        eventWorktreePath: '/repo/b',
        activeFileFullPath: '/repo/a/src/file.ts',
        changes: [],
      }),
    ).toBe(false);

    expect(
      shouldScheduleExternalRefresh({
        watchedWorktreePath: '/repo/a',
        eventWorktreePath: '/repo/a',
        activeFileFullPath: '/repo/a/src/file.ts',
        changes: [],
      }),
    ).toBe(false);

    expect(
      shouldScheduleExternalRefresh({
        watchedWorktreePath: '/repo/a',
        eventWorktreePath: '/repo/a',
        activeFileFullPath: '/repo/a/src/file.ts',
        changes: [{ path: '/repo/a/src/other.ts', type: 'change' }],
      }),
    ).toBe(false);

    expect(
      shouldScheduleExternalRefresh({
        watchedWorktreePath: '/repo/a',
        eventWorktreePath: '/repo/a',
        activeFileFullPath: '/repo/a/src/file.ts',
        changes: [{ path: '/repo/a/src/file.ts', type: 'change' }],
      }),
    ).toBe(true);

    expect(
      shouldScheduleExternalRefresh({
        watchedWorktreePath: '/repo/a',
        eventWorktreePath: '/repo/a',
        activeFileFullPath: '/repo/a/src/file.ts',
        changes: [{ path: '/repo/a/.git/index', type: 'change' }],
      }),
    ).toBe(true);
  });

  it('guards refreshed content application against tab switches and dirty/non-text files', () => {
    expect(
      shouldApplyExternalRefreshResult({
        activeFileKey: 'src/a.ts::/repo',
        incomingFileKey: 'src/a.ts::/repo',
        isDirty: false,
        isImageFile: false,
        isPdfFile: false,
      }),
    ).toBe(true);

    expect(
      shouldApplyExternalRefreshResult({
        activeFileKey: 'src/b.ts::/repo',
        incomingFileKey: 'src/a.ts::/repo',
        isDirty: false,
        isImageFile: false,
        isPdfFile: false,
      }),
    ).toBe(false);

    expect(
      shouldApplyExternalRefreshResult({
        activeFileKey: 'src/a.ts::/repo',
        incomingFileKey: 'src/a.ts::/repo',
        isDirty: true,
        isImageFile: false,
        isPdfFile: false,
      }),
    ).toBe(false);

    expect(
      shouldApplyExternalRefreshResult({
        activeFileKey: 'src/a.ts::/repo',
        incomingFileKey: 'src/a.ts::/repo',
        isDirty: false,
        isImageFile: true,
        isPdfFile: false,
      }),
    ).toBe(false);
  });
});

describe('CodeEditorPanel inline diff helpers', () => {
  it('enables inline diff for any text file with working changes', () => {
    expect(
      getInlineDiffState({
        isTextEditorFile: true,
        hasWorkingLineChanges: true,
        diffModePreference: true,
      }),
    ).toEqual({
      canShowInlineDiff: true,
      isDiffModeActive: true,
    });
  });

  it('keeps inline diff inactive when preference is off', () => {
    expect(
      getInlineDiffState({
        isTextEditorFile: true,
        hasWorkingLineChanges: true,
        diffModePreference: false,
      }),
    ).toEqual({
      canShowInlineDiff: true,
      isDiffModeActive: false,
    });
  });

  it('blocks inline diff for non-text files or unchanged files', () => {
    expect(
      getInlineDiffState({
        isTextEditorFile: false,
        hasWorkingLineChanges: true,
        diffModePreference: true,
      }).canShowInlineDiff,
    ).toBe(false);

    expect(
      getInlineDiffState({
        isTextEditorFile: true,
        hasWorkingLineChanges: false,
        diffModePreference: true,
      }).canShowInlineDiff,
    ).toBe(false);
  });

  it('auto-enables inline diff when availability changes from off to on', () => {
    expect(
      shouldAutoEnableInlineDiff({
        wasInlineDiffAvailable: false,
        isInlineDiffAvailable: true,
      }),
    ).toBe(true);

    expect(
      shouldAutoEnableInlineDiff({
        wasInlineDiffAvailable: true,
        isInlineDiffAvailable: true,
      }),
    ).toBe(false);
  });

  it('matches Cmd/Ctrl+Shift+I shortcut only when inline diff is available in panel', () => {
    expect(
      isInlineDiffToggleShortcut({
        key: 'I',
        code: 'KeyI',
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        isEditorOpen: true,
        canShowInlineDiff: true,
      }),
    ).toBe(true);

    expect(
      isInlineDiffToggleShortcut({
        key: 'I',
        code: 'KeyI',
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        isEditorOpen: true,
        canShowInlineDiff: true,
      }),
    ).toBe(true);

    expect(
      isInlineDiffToggleShortcut({
        key: 'I',
        code: 'KeyI',
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        isEditorOpen: true,
        canShowInlineDiff: false,
      }),
    ).toBe(false);

    expect(
      isInlineDiffToggleShortcut({
        key: 'I',
        code: 'KeyI',
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        isEditorOpen: false,
        canShowInlineDiff: true,
      }),
    ).toBe(false);
  });
});
