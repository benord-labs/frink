/**
 * Extract the quoted string (single or double) at or containing the given column.
 * Used by the alias definition provider to get import paths from any language.
 * Does not match template literals (backticks).
 */

export function extractQuotedStringAtPosition(line: string, column: number): string | null {
  const re = /(['"])((?:(?!\1).)+)\1/g;
  const col = column - 1; // Monaco `IPosition.column` is 1-based
  let match = re.exec(line);
  while (match !== null) {
    const quoted = match[2];
    if (quoted !== undefined) {
      const start = match.index; // opening quote (0-based)
      const end = match.index + 1 + quoted.length; // closing quote (0-based)
      if (col >= start && col <= end) return quoted;
    }
    match = re.exec(line);
  }
  return null;
}
