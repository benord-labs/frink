import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_HISTORY_FORMAT,
  FIELD_SEP,
  logFormat,
  parseCommitHistory,
  RECORD_SEP,
  splitLogRecords,
  toSafeIsoDate,
} from './commit-log';

const NOW = new Date('2026-01-02T03:04:05.000Z');

/** Mirror real `git log --format=...%x1e` output: records end with RECORD_SEP and are newline-separated. */
function gitOutput(...records: string[][]): string {
  return records.map((fields) => `${fields.join(FIELD_SEP)}${RECORD_SEP}`).join('\n') + '\n';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('logFormat', () => {
  it('joins placeholders with the field separator and terminates with the record separator', () => {
    expect(logFormat('%H', '%s')).toBe('--format=%H%x1f%s%x1e');
    expect(COMMIT_HISTORY_FORMAT).toBe('--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1e');
  });
});

describe('toSafeIsoDate', () => {
  it('normalises a valid git ISO date with an offset to UTC ISO', () => {
    expect(toSafeIsoDate('2025-06-01T12:00:00+02:00')).toBe('2025-06-01T10:00:00.000Z');
  });

  it.each([
    ['an unparseable string', 'garbage'],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('falls back to now for %s', (_label, input) => {
    expect(toSafeIsoDate(input)).toBe(NOW.toISOString());
  });
});

describe('splitLogRecords', () => {
  it('strips the newline git inserts between records and ignores the trailing blank record', () => {
    expect(splitLogRecords(gitOutput(['a', 'b'], ['c', 'd']), 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('skips records with the wrong field count', () => {
    expect(splitLogRecords(gitOutput(['a', 'b'], ['only-one'], ['a', 'b', 'c']), 2)).toEqual([
      ['a', 'b'],
    ]);
  });

  it('drops preamble lines git prints before a record (log.showSignature)', () => {
    const output =
      `Good "git" signature for a@b.c with ED25519 key SHA256:abc\n${['h1', 'x'].join(FIELD_SEP)}${RECORD_SEP}\n` +
      `gpg: Signature made Mon\ngpg: Good signature\n${['h2', 'y'].join(FIELD_SEP)}${RECORD_SEP}\n`;

    expect(splitLogRecords(output, 2)).toEqual([
      ['h1', 'x'],
      ['h2', 'y'],
    ]);
  });

  it('keeps newlines inside later fields while trimming the first-field preamble', () => {
    const output = `noise\n${['h', 'line 1\nline 2'].join(FIELD_SEP)}${RECORD_SEP}\n`;
    expect(splitLogRecords(output, 2)).toEqual([['h', 'line 1\nline 2']]);
  });

  it('accepts CRLF between records', () => {
    const output = `${['a', 'b'].join(FIELD_SEP)}${RECORD_SEP}\r\n${['c', 'd'].join(FIELD_SEP)}${RECORD_SEP}\r\n`;
    expect(splitLogRecords(output, 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(splitLogRecords('', 2)).toEqual([]);
    expect(splitLogRecords('\n', 2)).toEqual([]);
  });
});

describe('parseCommitHistory', () => {
  it('parses commits and normalises dates', () => {
    const output = gitOutput(
      [
        'abc123full',
        'abc123',
        'First commit',
        'Ada',
        'ada@example.com',
        '2025-06-01T12:00:00+02:00',
      ],
      ['def456full', 'def456', 'Second commit', 'Bob', 'bob@example.com', '2025-06-02T00:00:00Z'],
    );

    expect(parseCommitHistory(output)).toEqual([
      {
        hash: 'abc123full',
        shortHash: 'abc123',
        message: 'First commit',
        author: 'Ada',
        email: 'ada@example.com',
        date: '2025-06-01T10:00:00.000Z',
      },
      {
        hash: 'def456full',
        shortHash: 'def456',
        message: 'Second commit',
        author: 'Bob',
        email: 'bob@example.com',
        date: '2025-06-02T00:00:00.000Z',
      },
    ]);
  });

  it('keeps email and date intact when the subject contains "|"', () => {
    const [entry] = parseCommitHistory(
      gitOutput(['h', 's', 'fix: a | b', 'Ada', 'ada@example.com', '2025-06-01T00:00:00Z']),
    );

    expect(entry).toMatchObject({
      message: 'fix: a | b',
      email: 'ada@example.com',
      date: '2025-06-01T00:00:00.000Z',
    });
  });

  it('falls back to now for an invalid date', () => {
    const [entry] = parseCommitHistory(gitOutput(['h', 's', 'msg', 'Ada', 'a@b.c', 'not-a-date']));
    expect(entry?.date).toBe(NOW.toISOString());
  });

  it('returns an empty list for empty output', () => {
    expect(parseCommitHistory('')).toEqual([]);
  });
});
