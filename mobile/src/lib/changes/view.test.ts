import { describe, expect, it } from 'vitest';
import type {
  MobileActivity,
  MobileChangedFile,
  MobileChatChanges,
} from '@frink/shared/types/remote/mobile';
import {
  changeCount,
  changeSummary,
  countTurnEnd,
  diffRows,
  emptyKind,
  fileSections,
  lineLocation,
  omittedNote,
  toggled,
  withReference,
  type TurnCount,
} from './view';

const file: MobileChangedFile = {
  path: 'src/checkout.ts',
  status: 'modified',
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: '@@ -10,2 +10,2 @@',
      lines: [
        { kind: 'del', text: 'await sleep(500);', oldNo: 10 },
        { kind: 'add', text: 'await frame.ready();', newNo: 10 },
      ],
    },
  ],
};

const NONE: MobileChatChanges = {
  additions: 0,
  deletions: 0,
  fileCount: 0,
  files: [],
  truncated: false,
};

describe('changeCount', () => {
  it('reads as added and removed lines, and as nothing when the worktree is clean', () => {
    expect(changeCount({ ...NONE, additions: 38, deletions: 12, fileCount: 3 })).toBe('+38 −12');
    expect(changeCount(NONE)).toBeNull();
    expect(changeCount(undefined)).toBeNull();
  });

  it('still offers a diff too large to count', () => {
    expect(changeCount({ ...NONE, truncated: true })).toBe('Changes');
  });

  it('offers changes that have no lines to count, such as a new image', () => {
    expect(changeCount({ ...NONE, fileCount: 1 })).toBe('Changes');
  });
});

describe('countTurnEnd', () => {
  it('counts a turn each time running stops, and nothing else', () => {
    const activities: MobileActivity[] = [
      'idle',
      'running',
      'idle',
      'running',
      'background',
      'idle',
    ];
    let turns: TurnCount = { activity: undefined, ended: 0 };
    const seen = activities.map((activity) => (turns = countTurnEnd(turns, activity)).ended);
    expect(seen).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('keeps the same state when nothing changed, so a render does not loop', () => {
    const turns: TurnCount = { activity: 'idle', ended: 1 };
    expect(countTurnEnd(turns, 'idle')).toBe(turns);
  });
});

describe('line references', () => {
  it('names the new line, or the old one for a removed line', () => {
    const [removed, added] = file.hunks[0]?.lines ?? [];
    expect(added && lineLocation(file.path, added)).toBe('src/checkout.ts:10');
    expect(removed && lineLocation('old.ts', { ...removed, oldNo: 7 })).toBe('old.ts:7');
  });

  it('adds to a half-written draft on its own line instead of replacing it', () => {
    expect(withReference('', 'a.ts:3 - ')).toBe('a.ts:3 - ');
    expect(withReference('Also rename it  \n', 'a.ts:3 - ')).toBe('Also rename it\na.ts:3 - ');
  });
});

describe('diffRows', () => {
  it('flattens hunks into rows with stable, unique keys', () => {
    const rows = diffRows(file);
    expect(rows.map((row) => [row.type, row.key])).toEqual([
      ['hunk', 'src/checkout.ts:0'],
      ['line', 'src/checkout.ts:0:0'],
      ['line', 'src/checkout.ts:0:1'],
    ]);
  });
});

describe('fileSections', () => {
  it('hides a closed file’s rows but keeps its header', () => {
    const closed = toggled(new Set(), file.path);
    expect(fileSections([file], closed)[0]?.data).toEqual([]);
    expect(fileSections([file], toggled(closed, file.path))[0]?.data).toHaveLength(3);
  });
});

describe('changeSummary', () => {
  it('counts files and lines, and says nothing for a clean worktree', () => {
    const one = { ...NONE, fileCount: 1, additions: 2, deletions: 0 };
    expect(changeSummary(one)).toBe('1 file · +2 −0');
    expect(changeSummary({ ...one, fileCount: 3 })).toBe('3 files · +2 −0');
    expect(changeSummary(NONE)).toBeNull();
    expect(changeSummary(undefined)).toBeNull();
  });
});

describe('emptyKind', () => {
  it('spins while asking and shows nothing over an error with no answer yet', () => {
    expect(emptyKind(undefined, undefined)).toBe('loading');
    expect(emptyKind(undefined, 'Offline')).toBeNull();
  });

  it('calls a clean worktree clean, but not a diff too large to list', () => {
    expect(emptyKind(NONE, undefined)).toBe('clean');
    expect(emptyKind({ ...NONE, truncated: true }, undefined)).toBeNull();
  });
});

describe('omittedNote', () => {
  it('explains a hidden file only while it is open', () => {
    const secret: MobileChangedFile = { ...file, hunks: [], omitted: 'secret' };
    expect(omittedNote(secret, true)).toContain('may hold secrets');
    expect(omittedNote(secret, false)).toBeNull();
    expect(omittedNote(file, true)).toBeNull();
  });
});
