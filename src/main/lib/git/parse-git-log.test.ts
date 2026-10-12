import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIELD_SEP, RECORD_SEP } from './commit-log';
import { GIT_LOG_FORMAT, parseGitLog } from './utils/parse-status';

const NOW = new Date('2026-01-02T03:04:05.000Z');

type LogRecord = [
  hash: string,
  shortHash: string,
  subject: string,
  body: string,
  author: string,
  date: string,
];

/** Mirror real `git log --format=GIT_LOG_FORMAT` output. */
function gitOutput(...records: LogRecord[]): string {
  return records.map((fields) => `${fields.join(FIELD_SEP)}${RECORD_SEP}`).join('\n') + '\n';
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GIT_LOG_FORMAT', () => {
  it('requests hash, short hash, subject, body, author and ISO date', () => {
    expect(GIT_LOG_FORMAT).toBe('--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1e');
  });
});

describe('parseGitLog', () => {
  it('parses a commit and normalises its date to UTC ISO', () => {
    expect(
      parseGitLog(
        gitOutput(['abcfull', 'abc', 'Add thing', '', 'Ada', '2025-06-01T12:00:00+02:00']),
      ),
    ).toEqual([
      {
        hash: 'abcfull',
        shortHash: 'abc',
        message: 'Add thing',
        description: undefined,
        author: 'Ada',
        date: '2025-06-01T10:00:00.000Z',
        files: [],
      },
    ]);
  });

  it.each([
    ['unparseable', 'garbage'],
    ['empty', ''],
  ])('falls back to now when the date is %s', (_label, dateStr) => {
    const [commit] = parseGitLog(gitOutput(['h', 's', 'msg', '', 'Ada', dateStr]));
    expect(commit?.date).toBe(NOW.toISOString());
  });

  it('keeps a commit whose body spans multiple lines', () => {
    const body = 'First line of body.\n\nSecond paragraph.\n';
    const commits = parseGitLog(
      gitOutput(
        ['h1', 's1', 'With body', body, 'Ada', '2025-06-01T00:00:00Z'],
        ['h2', 's2', 'No body', '', 'Bob', '2025-06-02T00:00:00Z'],
      ),
    );

    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: 'h1',
      message: 'With body',
      description: 'First line of body.\n\nSecond paragraph.',
      author: 'Ada',
      date: '2025-06-01T00:00:00.000Z',
    });
    expect(commits[1]).toMatchObject({ hash: 'h2', description: undefined, author: 'Bob' });
  });

  it('preserves "|" in the subject and body without shifting fields', () => {
    const [commit] = parseGitLog(
      gitOutput(['h', 's', 'fix: a | b', 'x | y', 'Ada', '2025-06-01T00:00:00Z']),
    );

    expect(commit).toMatchObject({
      message: 'fix: a | b',
      description: 'x | y',
      author: 'Ada',
      date: '2025-06-01T00:00:00.000Z',
    });
  });

  it('skips records without a hash or short hash', () => {
    expect(
      parseGitLog(
        gitOutput(
          ['', 's', 'msg', '', 'Ada', '2025-06-01T00:00:00Z'],
          ['h', '', 'msg', '', 'Ada', '2025-06-01T00:00:00Z'],
        ),
      ),
    ).toEqual([]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('\n')).toEqual([]);
  });
});
