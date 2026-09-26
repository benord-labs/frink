export type DiffLine = {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
};

function getDiffLineBaseKey(line: DiffLine): string {
  return `${line.type}-${line.oldLineNo ?? 'na'}-${line.newLineNo ?? 'na'}-${line.content}`;
}

export function buildDiffLineKeys(lines: DiffLine[]): string[] {
  const countsByBaseKey = new Map<string, number>();

  return lines.map((line) => {
    const baseKey = getDiffLineBaseKey(line);
    const occurrenceCount = countsByBaseKey.get(baseKey) ?? 0;
    countsByBaseKey.set(baseKey, occurrenceCount + 1);
    return occurrenceCount === 0 ? baseKey : `${baseKey}-${occurrenceCount}`;
  });
}
