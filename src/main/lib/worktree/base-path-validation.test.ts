import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkWorktreeBasePath } from '../../../shared/lib/worktree-base-path-rules';
import {
  expandHomePath,
  isAbsoluteWorktreeBasePathInput,
  isSafeConfiguredWorktreeBasePath,
  isSensitiveWorktreeBasePath,
  normalizeWorktreeBasePath,
} from './base-path-validation';

describe('base-path-validation', () => {
  it('expands home shorthand and normalizes path', () => {
    const expanded = expandHomePath('~/worktrees-custom');
    expect(expanded.endsWith('/worktrees-custom')).toBe(true);
    expect(normalizeWorktreeBasePath('~/worktrees-custom').endsWith('/worktrees-custom')).toBe(
      true,
    );
  });

  it('detects absolute input requirements', () => {
    expect(isAbsoluteWorktreeBasePathInput('/tmp/worktrees')).toBe(true);
    expect(isAbsoluteWorktreeBasePathInput('relative/worktrees')).toBe(false);
  });

  it('flags sensitive paths', () => {
    const home = os.homedir();
    expect(isSensitiveWorktreeBasePath('/')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/etc')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/bin')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/usr')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/var')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/private')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/System')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/root')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/root/worktrees')).toBe(true);
    expect(isSensitiveWorktreeBasePath('/etc/myworktrees')).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.ssh`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.aws`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.gnupg`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.config`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.docker`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.kube`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.netrc`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.npm`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.local`)).toBe(true);
    expect(isSensitiveWorktreeBasePath(`${home}/.cache`)).toBe(true);
  });

  it('checks configured path safety', () => {
    expect(isSafeConfiguredWorktreeBasePath('/tmp/worktrees')).toBe(true);
    expect(isSafeConfiguredWorktreeBasePath('/')).toBe(false);
    expect(isSafeConfiguredWorktreeBasePath('relative/worktrees')).toBe(false);
  });
});

/**
 * The renderer pre-checks base paths with the pure mirror in
 * `src/shared/lib/worktree-base-path-rules.ts` so the settings field never shows a green state for
 * a path this validator would refuse.
 *
 * THE INVARIANT THAT MATTERS is anti-looseness: whatever the mirror ACCEPTS, this validator must
 * also accept. Its failure mode is the defect the mirror was written to remove — a green field
 * followed by a failed save. Asserting the opposite direction (mirror-refuses implies
 * backend-refuses) would leave that case entirely unchecked.
 *
 * The reverse direction is asserted too, but only as a record that the two agree on posix today.
 * The mirror is permitted to be stricter — it deliberately is on win32, where it refuses `/etc`
 * while this validator resolves that to `\etc` and accepts it (see the win32 rows in the mirror's
 * own suite). If a future deliberate strictness lands on posix, relax that half, never the first.
 */
describe('parity with the renderer pre-check', () => {
  const home = os.homedir();
  const inputs = [
    '',
    'relative/worktrees',
    '/tmp/worktrees',
    '~/worktrees',
    '~',
    '~/.frink',
    '~/.ssh',
    '~/projects/../.ssh',
    '/tmp/../etc',
    '/..',
    '/',
    '/etc',
    '/etc/myworktrees',
    '/root/worktrees',
    'C:/worktrees',
    'C:',
    '//server/share',
    `${home}/.aws`,
    `${home}/worktrees`,
    '~/.frink/worktrees',
    '/etcetera',
    '~/.sshfoo',
    '~/.ssh/',
    '  ~/.ssh  ',
    '~alice/worktrees',
    '/foo/~/bar',
    '/tmp/worktrees/',
  ];

  // Blank input never reaches this validator: it means "no override", and the save omits the key.
  it.each(inputs.filter((input) => input.trim().length > 0))('agrees on %j', (input) => {
    const verdict = checkWorktreeBasePath(input, { homeDir: home, platform: 'posix' });

    if (verdict === null) {
      // Anti-looseness: a field the mirror leaves green must be one the save accepts.
      expect(isSafeConfiguredWorktreeBasePath(input)).toBe(true);
      return;
    }
    expect(isSafeConfiguredWorktreeBasePath(input)).toBe(false);
  });
});
