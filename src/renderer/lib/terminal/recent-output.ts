import type { IBuffer, IBufferLine } from 'xterm';

/** The rows the reader needs, so a test can hand it a plain object. */
export type OutputBuffer = Pick<IBuffer, 'length'> & {
  getLine(row: number): Pick<IBufferLine, 'isWrapped' | 'translateToString'> | undefined;
};

const RECENT_OUTPUT_MAX_LINES = 200;
const RECENT_OUTPUT_MAX_CHARS = 20_000;

/**
 * The last `maxLines` lines, read up from the bottom row since vim leaves output below the cursor,
 * then the last `maxChars`. A wrapped line counts once; '' when every line is blank.
 */
export function readRecentOutput(
  buffer: OutputBuffer,
  maxLines = RECENT_OUTPUT_MAX_LINES,
  maxChars = RECENT_OUTPUT_MAX_CHARS,
): string {
  const lines: string[] = [];
  let logical = '';
  let isLastSegment = true;
  for (let row = buffer.length - 1; row >= 0 && lines.length < maxLines; row--) {
    const line = buffer.getLine(row);
    if (!line) continue;
    // A row that continues onto the next keeps its trailing spaces, or the wrap glues words.
    logical = line.translateToString(isLastSegment) + logical;
    isLastSegment = !line.isWrapped;
    if (line.isWrapped) continue;
    if (lines.length > 0 || logical.trim()) lines.push(logical);
    logical = '';
  }
  // The oldest row can continue a line the scrollback has already dropped.
  if (logical.trim() && lines.length < maxLines) lines.push(logical);
  lines.reverse();

  let total = lines.reduce((sum, line) => sum + line.length + 1, -1);
  while (lines.length > 1 && total > maxChars) total -= (lines.shift() ?? '').length + 1;
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
