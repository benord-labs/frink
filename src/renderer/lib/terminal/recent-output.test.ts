import { describe, expect, it } from 'vitest';
import { type OutputBuffer, readRecentOutput } from './recent-output';

/** A buffer whose rows are `width` cells wide, like xterm's: `translateToString(false)` pads.
 *  `wrappedRows` are the rows that continue the row above them. */
function buffer(rows: string[], wrappedRows: number[] = [], width = 10): OutputBuffer {
  return {
    length: rows.length,
    getLine: (row) => {
      const text = rows.at(row);
      if (text === undefined) return undefined;
      return {
        isWrapped: wrappedRows.includes(row),
        translateToString: (trimRight?: boolean) =>
          trimRight ? text.trimEnd() : text.padEnd(width),
      };
    },
  };
}

describe('readRecentOutput', () => {
  it('joins a line xterm wrapped over several rows, keeping the space at the wrap', () => {
    const out = readRecentOutput(buffer(['$ bun test', 'Error: an ', 'value'], [2]));
    expect(out).toBe('$ bun test\nError: an value');
  });

  it('drops the blank rows below the prompt but keeps blank lines inside the output', () => {
    const out = readRecentOutput(buffer(['FAIL a.test', '', '   ', '$', '', '']));
    expect(out).toBe('FAIL a.test\n\n\n$');
  });

  it('keeps the newest lines when there are more than the line cap', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    expect(readRecentOutput(buffer(rows), 3)).toBe('line 7\nline 8\nline 9');
  });

  it('counts a wrapped line once against the line cap', () => {
    const out = readRecentOutput(buffer(['old', 'long line ', 'continues', 'last'], [2]), 2);
    expect(out).toBe('long line continues\nlast');
  });

  it('cuts to the character cap from the start, on a whole line', () => {
    expect(readRecentOutput(buffer(['aaaa', 'bbbb', 'cccc']), 200, 9)).toBe('bbbb\ncccc');
  });

  it('keeps the end of a single line longer than the character cap', () => {
    expect(readRecentOutput(buffer(['0123456789']), 200, 4)).toBe('6789');
  });

  it('keeps the rows below the cursor', () => {
    const out = readRecentOutput(buffer(['  1 const a', '  2 const b', '~', '']));
    expect(out).toBe('  1 const a\n  2 const b\n~');
  });

  it('returns an empty string when every line is blank', () => {
    expect(readRecentOutput(buffer(['', '  ', '']))).toBe('');
  });
});
