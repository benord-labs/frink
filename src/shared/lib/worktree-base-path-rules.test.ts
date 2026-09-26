import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkWorktreeBasePath,
  type WorktreeBasePathVerdict,
  worktreeBasePathErrorMessage,
} from './worktree-base-path-rules';

/**
 * Platforms are passed explicitly rather than read from `process.platform`: the Windows rows are
 * the ones this module was written for, and binding to the host would leave them unrun on a
 * macOS/Linux CI box.
 */
const POSIX_HOME = '/Users/testuser';
const WIN32_HOME = 'C:/Users/testuser';
const NODE_PATH = { posix, win32 };

type Row = [input: string, expected: WorktreeBasePathVerdict, note?: string];

const POSIX_ROWS: Row[] = [
  ['', null, 'empty means "no override" — each surface decides'],
  ['   ', null],
  ['relative/worktrees', 'not-absolute'],
  ['C:/worktrees', 'not-absolute', 'a drive path is not absolute on posix'],
  ['C:', 'not-absolute'],
  ['/tmp/worktrees', null],
  ['~/worktrees', null],
  ['/a/./b//c/', null, 'redundant separators collapse without changing the verdict'],
  ['//server/share', null, 'collapses to /server/share; accepted, as the backend accepts it'],
  ['~', 'sensitive', 'the home directory itself'],
  ['~/.frink', 'sensitive'],
  ['/', 'sensitive'],
  ['/..', 'sensitive', 'clamps at root rather than escaping above it'],
  ['/etc', 'sensitive'],
  ['/etc/myworktrees', 'sensitive'],
  ['~/.ssh', 'sensitive'],
  ['/Users/testuser/.aws', 'sensitive'],
  ['~/projects/../.ssh', 'sensitive', 'the traversal this module exists to catch'],
  ['/tmp/../etc', 'sensitive', 'same traversal, no tilde needed'],
  // The shipped default lives inside ~/.frink. Only the directory itself is refused, so a
  // stock install must not light up the field it seeds.
  ['~/.frink/worktrees', null, 'the default base path'],
  ['~/.frink/worktrees/proj/branch', null],
  // Prefix matching must stop at a separator, or neighbouring directories get swept up.
  ['/etcetera', null, 'shares a prefix with /etc but is not inside it'],
  ['~/.sshfoo', null],
  ['/vartmp', null],
  ['~/.ssh/', 'sensitive', 'a trailing slash, as pasted from a file manager'],
  ['/tmp/worktrees/', null],
  ['  ~/.ssh  ', 'sensitive', 'surrounding whitespace, as pasted'],
  ['~alice/worktrees', 'not-absolute', 'another user’s home is not expanded, matching the backend'],
  ['/foo/~/bar', null, 'a tilde only expands in the leading position'],
];

const WIN32_ROWS: Row[] = [
  ['C:/worktrees', null],
  ['C:\\worktrees', null, 'backslashes normalize before any comparison'],
  ['/foo', null, 'win32 treats a bare leading slash as absolute (drive-relative)'],
  ['relative\\x', 'not-absolute'],
  ['C:', 'not-absolute', 'a bare drive is drive-relative, matching path.win32.isAbsolute'],
  ['C:/', 'sensitive', 'the drive root'],
  ['C:/a/../..', 'sensitive', 'clamps at the drive root'],
  ['~/worktrees', null],
  ['~/.aws', 'sensitive'],
  ['C:\\Users\\testuser\\.ssh', 'sensitive'],
  ['C:/Users/testuser/projects/../.gnupg', 'sensitive'],
  ['~\\worktrees', null, 'the backslash tilde form the backend also accepts'],
  ['C:foo', 'not-absolute', 'drive-relative, matching path.win32.isAbsolute'],
  ['C:/Users/testuser/.frink/worktrees', null, 'the default base path'],
  // Deliberately stricter than the backend here: on Windows the backend resolves this to `\etc`,
  // which its forward-slash prefix check never matches, so it would accept it. Refusing is the
  // safe direction and nobody roots worktrees at a drive-relative /etc on Windows.
  ['/etc', 'sensitive', 'stricter than the backend on this platform, by choice'],
];

describe('checkWorktreeBasePath', () => {
  describe.each([
    ['posix' as const, POSIX_HOME, POSIX_ROWS],
    ['win32' as const, WIN32_HOME, WIN32_ROWS],
  ])('on %s', (platform, homeDir, rows) => {
    it.each(rows)('%j -> %s %s', (input, expected) => {
      expect(checkWorktreeBasePath(input, { homeDir, platform })).toBe(expected);
    });
  });

  it('matches path.isAbsolute per flavour for non-tilde input', () => {
    const inputs = ['C:/worktrees', 'C:', '/foo', 'relative/x', '//server/share', '/'];
    for (const input of inputs) {
      for (const platform of ['posix', 'win32'] as const) {
        const homeDir = platform === 'win32' ? WIN32_HOME : POSIX_HOME;
        const rejectedAsRelative =
          checkWorktreeBasePath(input, { homeDir, platform }) === 'not-absolute';
        expect(rejectedAsRelative, `${input} on ${platform}`).toBe(
          !NODE_PATH[platform].isAbsolute(input),
        );
      }
    }
  });

  // An empty string is a home directory we do not have, not a home directory at the filesystem
  // root. Treating it as known silently un-checks every home-relative secret.
  it.each([[''], ['   ']])('treats a blank home directory (%j) as unknown', (homeDir) => {
    expect(checkWorktreeBasePath('/tmp/x', { homeDir, platform: 'posix' })).toBe('unknown');
    expect(checkWorktreeBasePath('~/.aws', { homeDir, platform: 'posix' })).toBe('unknown');
  });

  // A root home directory is real for daemon/container accounts. The join must not collapse to
  // an empty string, which would misreport `~` as a relative path.
  describe('with the home directory at the filesystem root', () => {
    const ctx = { homeDir: '/', platform: 'posix' as const };

    // `~` must read as the home directory itself, never as a relative path.
    it.each([
      ['~', 'sensitive'],
      ['~/.ssh', 'sensitive'],
      ['~/worktrees', null],
    ] satisfies [string, WorktreeBasePathVerdict][])('%j -> %s', (input, expected) => {
      expect(checkWorktreeBasePath(input, ctx)).toBe(expected);
    });
  });

  it('accepts a case-variant secret directory, mirroring the backend rather than improving on it', () => {
    // The backend compares exactly, so it accepts this on a case-insensitive filesystem.
    // Rejecting here would block a path the save would allow. Deliberate — do not "fix".
    expect(
      checkWorktreeBasePath('/Users/testuser/.SSH', { homeDir: POSIX_HOME, platform: 'posix' }),
    ).toBeNull();
  });

  describe('without a home directory', () => {
    const ctx = { platform: 'posix' as const };

    // Nothing home-relative is judgeable, and an absolute path could still be a home secret.
    it.each([['~/.aws'], ['~'], ['/Users/testuser/.aws'], ['/tmp/worktrees']])(
      'cannot judge %j',
      (input) => {
        expect(checkWorktreeBasePath(input, ctx)).toBe('unknown');
      },
    );

    it.each([
      ['relative/x', 'not-absolute'],
      ['/etc', 'sensitive'],
      ['/', 'sensitive'],
    ] satisfies [string, WorktreeBasePathVerdict][])(
      'still refuses %j without needing the home directory',
      (input, expected) => {
        expect(checkWorktreeBasePath(input, ctx)).toBe(expected);
      },
    );

    it('never reports a verdict of valid, which was the defect being fixed', () => {
      const everyInput = [...POSIX_ROWS.map(([input]) => input), '/Users/testuser/.aws'];
      for (const input of everyInput.filter((input) => input.trim().length > 0)) {
        expect(checkWorktreeBasePath(input, ctx), input).not.toBeNull();
      }
    });
  });
});

describe('worktreeBasePathErrorMessage', () => {
  it('speaks only for refusals', () => {
    expect(worktreeBasePathErrorMessage('not-absolute')).toBe('Path must be an absolute path.');
    expect(worktreeBasePathErrorMessage('sensitive')).toBe(
      'Please choose a more specific directory for worktrees.',
    );
    expect(worktreeBasePathErrorMessage('unknown')).toBeNull();
    expect(worktreeBasePathErrorMessage(null)).toBeNull();
  });
});
