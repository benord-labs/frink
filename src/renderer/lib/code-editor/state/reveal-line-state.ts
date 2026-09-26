export type RevealLineDetail = {
  filePath: string;
  lineNumber: number;
  startColumn?: number;
  endColumn?: number;
};

type NormalizedRevealSelection = {
  clampedLine: number;
  startColumn: number;
  endColumn: number;
  hasRange: boolean;
};

export function normalizeRevealSelection(
  detail: RevealLineDetail,
  modelLineCount: number,
  getLineMaxColumn: (lineNumber: number) => number,
): NormalizedRevealSelection {
  const clampedLine = Math.min(Math.max(Math.floor(detail.lineNumber), 1), modelLineCount);
  const maxColumn = getLineMaxColumn(clampedLine);
  const hasRange =
    typeof detail.startColumn === 'number' &&
    typeof detail.endColumn === 'number' &&
    detail.startColumn > 0 &&
    detail.endColumn >= detail.startColumn;
  const startColumn = hasRange
    ? Math.min(Math.max(Math.floor(detail.startColumn ?? 1), 1), maxColumn)
    : 1;
  const endColumn = hasRange
    ? Math.min(Math.max(Math.floor(detail.endColumn ?? startColumn), startColumn), maxColumn)
    : startColumn;

  return {
    clampedLine,
    startColumn,
    endColumn,
    hasRange,
  };
}

function normalizePathForReveal(path: string): string {
  try {
    const decoded = decodeURIComponent(path);
    const trimmed = decoded.endsWith('/') ? decoded.slice(0, -1) : decoded;
    if (typeof process !== 'undefined' && process.platform === 'win32') {
      return trimmed.replace(/\\/g, '/').toLowerCase();
    }
    return trimmed;
  } catch {
    return path;
  }
}

export function shouldRevealNow(
  detail: RevealLineDetail,
  activeAbsoluteFilePath: string | null,
  isTextEditorFile: boolean,
): boolean {
  if (!isTextEditorFile || !activeAbsoluteFilePath) return false;
  return normalizePathForReveal(detail.filePath) === normalizePathForReveal(activeAbsoluteFilePath);
}

export function consumePendingReveal(
  pending: RevealLineDetail | null,
  activeAbsoluteFilePath: string | null,
  isTextEditorFile: boolean,
): RevealLineDetail | null {
  if (!pending) return null;
  if (!shouldRevealNow(pending, activeAbsoluteFilePath, isTextEditorFile)) return null;
  return pending;
}
