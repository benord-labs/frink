import { normalizePathSlashes } from '../../../../shared/lib/path-normalization';

export function normalizePath(pathValue: string): string {
  return normalizePathSlashes(pathValue);
}

export function isGitPointerPath(pathValue: string): boolean {
  const normalizedPath = normalizePath(pathValue);
  return (
    normalizedPath.endsWith('/.git/HEAD') ||
    normalizedPath.endsWith('/.git/index') ||
    normalizedPath.endsWith('/.git/packed-refs') ||
    normalizedPath.includes('/.git/refs/')
  );
}

export function canAutoRefreshFromExternalChange(input: {
  isDirty: boolean;
  hasContent: boolean;
  hasLoadError: boolean;
  isTextEditorFile: boolean;
}): boolean {
  return input.isTextEditorFile && input.hasContent && !input.isDirty && !input.hasLoadError;
}

export function shouldScheduleExternalRefresh(input: {
  watchedWorktreePath: string;
  eventWorktreePath: string;
  activeFileFullPath: string;
  changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
}): boolean {
  if (normalizePath(input.watchedWorktreePath) !== normalizePath(input.eventWorktreePath)) {
    return false;
  }

  // Without explicit event reason metadata we cannot safely infer target file changes.
  // Empty change arrays should not trigger content reloads.
  if (input.changes.length === 0) {
    return false;
  }

  const normalizedActiveFilePath = normalizePath(input.activeFileFullPath);
  return input.changes.some((change) => {
    const normalizedChangedPath = normalizePath(change.path);
    return (
      normalizedChangedPath === normalizedActiveFilePath || isGitPointerPath(normalizedChangedPath)
    );
  });
}

export function shouldApplyExternalRefreshResult(input: {
  activeFileKey: string;
  incomingFileKey: string;
  isDirty: boolean;
  isImageFile: boolean;
  isPdfFile: boolean;
}): boolean {
  return (
    input.activeFileKey === input.incomingFileKey &&
    !input.isDirty &&
    !input.isImageFile &&
    !input.isPdfFile
  );
}
