import { diffLines, diffWordsWithSpace } from 'diff';

type InlineDiffLineDecoration = {
  type: 'added' | 'modified';
  startLine: number;
  endLine: number;
};

type InlineDiffTokenDecoration = {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
};

type InlineDeletedBlock = {
  afterLineNumber: number;
  lines: string[];
};

type InlineDiffLayout = {
  lineDecorations: InlineDiffLineDecoration[];
  tokenDecorations: InlineDiffTokenDecoration[];
  deletedBlocks: InlineDeletedBlock[];
  hasChanges: boolean;
};

type TokenRange = {
  start: number;
  end: number;
};

function toLogicalLines(value: string): string[] {
  if (value.length === 0) return [];
  const parts = value.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function getAddedTokenRanges(oldLine: string, newLine: string): TokenRange[] {
  const ranges: TokenRange[] = [];
  const parts = diffWordsWithSpace(oldLine, newLine);
  let column = 1;

  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      if (len > 0) {
        ranges.push({ start: column, end: column + len });
      }
      column += len;
    } else if (!part.removed) {
      column += len;
    }
  }

  return ranges;
}

export function buildInlineDiffLayout(
  originalText: string,
  modifiedText: string,
): InlineDiffLayout {
  if (originalText === modifiedText) {
    return { lineDecorations: [], tokenDecorations: [], deletedBlocks: [], hasChanges: false };
  }

  const lineDecorations: InlineDiffLineDecoration[] = [];
  const tokenDecorations: InlineDiffTokenDecoration[] = [];
  const deletedBlocks: InlineDeletedBlock[] = [];
  const lineDiff = diffLines(originalText, modifiedText);

  let modifiedLine = 1;

  for (let i = 0; i < lineDiff.length; i += 1) {
    const current = lineDiff[i];
    if (!current) continue;

    if (!current.added && !current.removed) {
      modifiedLine += toLogicalLines(current.value).length;
      continue;
    }

    if (current.removed) {
      const next = lineDiff[i + 1];

      if (next?.added) {
        const removedLines = toLogicalLines(current.value);
        const addedLines = toLogicalLines(next.value);
        const sharedCount = Math.min(removedLines.length, addedLines.length);

        if (sharedCount > 0) {
          deletedBlocks.push({
            afterLineNumber: Math.max(0, modifiedLine - 1),
            lines: removedLines.slice(0, sharedCount),
          });

          lineDecorations.push({
            type: 'modified',
            startLine: modifiedLine,
            endLine: modifiedLine + sharedCount - 1,
          });

          for (let offset = 0; offset < sharedCount; offset += 1) {
            const oldLine = removedLines[offset] ?? '';
            const newLine = addedLines[offset] ?? '';
            for (const range of getAddedTokenRanges(oldLine, newLine)) {
              tokenDecorations.push({
                lineNumber: modifiedLine + offset,
                startColumn: range.start,
                endColumn: range.end,
              });
            }
          }
        }

        if (addedLines.length > sharedCount) {
          const startLine = modifiedLine + sharedCount;
          lineDecorations.push({
            type: 'added',
            startLine,
            endLine: startLine + (addedLines.length - sharedCount) - 1,
          });
        }

        if (removedLines.length > sharedCount) {
          deletedBlocks.push({
            afterLineNumber: Math.max(0, modifiedLine + sharedCount - 1),
            lines: removedLines.slice(sharedCount),
          });
        }

        modifiedLine += addedLines.length;
        i += 1;
        continue;
      }

      const removedLines = toLogicalLines(current.value);
      if (removedLines.length > 0) {
        deletedBlocks.push({
          afterLineNumber: Math.max(0, modifiedLine - 1),
          lines: removedLines,
        });
      }
      continue;
    }

    if (current.added) {
      const addedLines = toLogicalLines(current.value);
      if (addedLines.length > 0) {
        lineDecorations.push({
          type: 'added',
          startLine: modifiedLine,
          endLine: modifiedLine + addedLines.length - 1,
        });
      }
      modifiedLine += addedLines.length;
    }
  }

  return {
    lineDecorations,
    tokenDecorations,
    deletedBlocks,
    hasChanges:
      lineDecorations.length > 0 || tokenDecorations.length > 0 || deletedBlocks.length > 0,
  };
}
