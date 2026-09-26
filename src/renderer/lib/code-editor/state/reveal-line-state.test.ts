import { describe, expect, it } from 'vitest';
import {
  consumePendingReveal,
  normalizeRevealSelection,
  shouldRevealNow,
} from './reveal-line-state';

describe('reveal-line-state', () => {
  it('reveals immediately when active file matches and editor is text mode', () => {
    expect(
      shouldRevealNow({ filePath: '/repo/src/a.ts', lineNumber: 12 }, '/repo/src/a.ts', true),
    ).toBe(true);
  });

  it('queues (does not consume) when active file does not match yet', () => {
    const detail = consumePendingReveal(
      { filePath: '/repo/src/a.ts', lineNumber: 12 },
      '/repo/src/b.ts',
      true,
    );
    expect(detail).toBeNull();
  });

  it('queues (does not consume) for non-text editor files', () => {
    const detail = consumePendingReveal(
      { filePath: '/repo/src/a.ts', lineNumber: 12 },
      '/repo/src/a.ts',
      false,
    );
    expect(detail).toBeNull();
  });

  it('consumes queued reveal detail once active file matches and is text', () => {
    const detail = consumePendingReveal(
      { filePath: '/repo/src/a.ts', lineNumber: 12, startColumn: 6, endColumn: 12 },
      '/repo/src/a.ts',
      true,
    );
    expect(detail).toEqual({
      filePath: '/repo/src/a.ts',
      lineNumber: 12,
      startColumn: 6,
      endColumn: 12,
    });
  });

  it('does not consume stale pending reveal for another file', () => {
    const detail = consumePendingReveal(
      { filePath: '/repo/src/b.ts', lineNumber: 99, startColumn: 1, endColumn: 5 },
      '/repo/src/a.ts',
      true,
    );
    expect(detail).toBeNull();
  });

  it('normalizes line number and invalid range values safely', () => {
    const normalized = normalizeRevealSelection(
      { filePath: '/repo/src/a.ts', lineNumber: 999, startColumn: 20, endColumn: 10 },
      10,
      () => 30,
    );
    expect(normalized).toEqual({
      clampedLine: 10,
      startColumn: 1,
      endColumn: 1,
      hasRange: false,
    });
  });

  it('clamps end column at line max for end-of-line selections', () => {
    const normalized = normalizeRevealSelection(
      { filePath: '/repo/src/a.ts', lineNumber: 5, startColumn: 8, endColumn: 50 },
      20,
      () => 12,
    );
    expect(normalized).toEqual({
      clampedLine: 5,
      startColumn: 8,
      endColumn: 12,
      hasRange: true,
    });
  });

  describe('path normalization (reveal-line edge cases)', () => {
    it('returns true when filePath has %20 and activeAbsoluteFilePath has literal space (normalized)', () => {
      expect(
        shouldRevealNow(
          { filePath: '/path/with%20spaces/file.ts', lineNumber: 1 },
          '/path/with spaces/file.ts',
          true,
        ),
      ).toBe(true);
    });

    it('returns true when activeAbsoluteFilePath has %20 and filePath has literal space (normalized)', () => {
      expect(
        shouldRevealNow(
          { filePath: '/path/with spaces/file.ts', lineNumber: 1 },
          '/path/with%20spaces/file.ts',
          true,
        ),
      ).toBe(true);
    });

    it('returns true when one path has trailing slash and the other does not (normalized)', () => {
      expect(
        shouldRevealNow({ filePath: '/repo/src/a.ts/', lineNumber: 1 }, '/repo/src/a.ts', true),
      ).toBe(true);
      expect(
        shouldRevealNow({ filePath: '/repo/src/a.ts', lineNumber: 1 }, '/repo/src/a.ts/', true),
      ).toBe(true);
    });

    it('returns true when paths match exactly', () => {
      expect(
        shouldRevealNow({ filePath: '/repo/src/a.ts', lineNumber: 1 }, '/repo/src/a.ts', true),
      ).toBe(true);
    });

    it('uses Windows case-insensitive comparison when platform is win32', () => {
      const expected = process.platform === 'win32';
      expect(
        shouldRevealNow({ filePath: '/Repo/File.ts', lineNumber: 1 }, '/repo/file.ts', true),
      ).toBe(expected);
    });

    it.runIf(process.platform === 'win32')(
      'on win32, normalizes backslashes to slashes before compare',
      () => {
        expect(
          shouldRevealNow(
            { filePath: 'C:\\Repo\\src\\a.ts', lineNumber: 1 },
            'c:/repo/src/a.ts',
            true,
          ),
        ).toBe(true);
        expect(
          shouldRevealNow(
            { filePath: 'c:/repo/src/a.ts', lineNumber: 1 },
            'C:\\Repo\\src\\a.ts',
            true,
          ),
        ).toBe(true);
      },
    );

    it('falls back to raw path comparison when decodeURIComponent throws on malformed encoding', () => {
      const malformed = '/path/with%E0%A4bad/file.ts';
      expect(shouldRevealNow({ filePath: malformed, lineNumber: 1 }, malformed, true)).toBe(true);
      expect(
        shouldRevealNow(
          { filePath: malformed, lineNumber: 1 },
          '/path/with%E0%A4bad/other-file.ts',
          true,
        ),
      ).toBe(false);
    });
  });
});
