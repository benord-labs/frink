import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathValidationError } from './path-validation';
import { secureFs } from './secure-fs';

/**
 * secureFs holds no allowlist of "known" worktrees — the worktree path its caller
 * names is trusted. What it still enforces is containment *within* that path: a
 * repository the user cloned can carry a symlink that makes a file look in-repo while
 * it actually reads or writes elsewhere. These tests pin that distinction so the
 * containment half is not dropped alongside the registration half.
 */
describe('secureFs containment', () => {
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'frink-secure-fs-wt-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-secure-fs-out-'));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads and writes a plain file inside the worktree', async () => {
    await writeFile(join(worktree, 'notes.md'), 'hello', 'utf8');

    await expect(secureFs.readFile(worktree, 'notes.md')).resolves.toBe('hello');

    await secureFs.writeFile(worktree, 'notes.md', 'updated');
    await expect(readFile(join(worktree, 'notes.md'), 'utf8')).resolves.toBe('updated');
  });

  it('refuses to write through a symlink escaping the worktree', async () => {
    const target = join(outside, 'bashrc');
    await writeFile(target, 'original', 'utf8');
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await symlink(target, join(worktree, 'docs', 'config.yml'));

    await expect(secureFs.writeFile(worktree, 'docs/config.yml', 'pwned')).rejects.toThrow(
      PathValidationError,
    );
    // The link target is untouched — the write never followed the link.
    await expect(readFile(target, 'utf8')).resolves.toBe('original');
  });

  it('refuses to write through a dangling symlink escaping the worktree', async () => {
    const target = join(outside, 'authorized_keys');
    await mkdir(join(worktree, 'docs'), { recursive: true });
    await symlink(target, join(worktree, 'docs', 'notes.md'));

    await expect(secureFs.writeFile(worktree, 'docs/notes.md', 'pwned')).rejects.toThrow(
      PathValidationError,
    );
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('refuses to read through a symlink escaping the worktree', async () => {
    const target = join(outside, 'secret');
    await writeFile(target, 'classified', 'utf8');
    await symlink(target, join(worktree, 'link.txt'));

    await expect(secureFs.readFile(worktree, 'link.txt')).rejects.toThrow(PathValidationError);
  });

  it('rejects absolute and traversing relative paths', async () => {
    await expect(secureFs.readFile(worktree, join(outside, 'secret'))).rejects.toThrow(
      PathValidationError,
    );
    await expect(secureFs.readFile(worktree, '../escape.txt')).rejects.toThrow(PathValidationError);
  });

  it('does not require the worktree to be registered anywhere', async () => {
    // No database row, no project registration — an arbitrary directory works.
    await writeFile(join(worktree, 'plan.md'), '# plan', 'utf8');
    await expect(secureFs.readFile(worktree, 'plan.md')).resolves.toBe('# plan');
  });
});

/**
 * Every secureFs method lost its registration check, leaving containment as the only
 * guard. readFile and writeFile are covered above; these are the remaining methods that
 * inspect or read a path, each of which a caller may reach with a repo-supplied name.
 */
describe('secureFs inspection and buffer reads', () => {
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'frink-secure-fs-insp-wt-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-secure-fs-insp-out-'));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads bytes inside the worktree but refuses an escaping symlink', async () => {
    await writeFile(join(worktree, 'logo.png'), 'bytes', 'utf8');
    const secret = join(outside, 'secret.png');
    await writeFile(secret, 'classified', 'utf8');
    await symlink(secret, join(worktree, 'linked.png'));

    const buffer = await secureFs.readFileBuffer(worktree, 'logo.png');
    expect(buffer.toString('utf8')).toBe('bytes');

    await expect(secureFs.readFileBuffer(worktree, 'linked.png')).rejects.toThrow(
      PathValidationError,
    );
  });

  it('stats a file inside the worktree but refuses an escaping symlink', async () => {
    await writeFile(join(worktree, 'inside.txt'), 'abc', 'utf8');
    const target = join(outside, 'outside.txt');
    await writeFile(target, 'abcdefgh', 'utf8');
    await symlink(target, join(worktree, 'link.txt'));

    const stats = await secureFs.stat(worktree, 'inside.txt');
    expect(stats.size).toBe(3);

    await expect(secureFs.stat(worktree, 'link.txt')).rejects.toThrow(PathValidationError);
  });

  it('reports existence only for paths contained in the worktree', async () => {
    await writeFile(join(worktree, 'here.txt'), 'x', 'utf8');
    const target = join(outside, 'there.txt');
    await writeFile(target, 'x', 'utf8');
    await symlink(target, join(worktree, 'escape.txt'));

    await expect(secureFs.exists(worktree, 'here.txt')).resolves.toBe(true);
    await expect(secureFs.exists(worktree, 'missing.txt')).resolves.toBe(false);
    // The link resolves to a real file, but one outside the worktree.
    await expect(secureFs.exists(worktree, 'escape.txt')).resolves.toBe(false);
  });

  it('reports where an escaping symlink leads so callers can warn the user', async () => {
    const target = join(outside, 'bashrc');
    await writeFile(target, 'x', 'utf8');
    await symlink(target, join(worktree, 'escaping.txt'));
    await writeFile(join(worktree, 'real.txt'), 'x', 'utf8');
    await symlink(join(worktree, 'real.txt'), join(worktree, 'internal.txt'));

    await expect(secureFs.escapeTarget(worktree, 'escaping.txt')).resolves.toBe(
      await realpath(target),
    );
    // A symlink that stays inside the worktree is not an escape.
    await expect(secureFs.escapeTarget(worktree, 'internal.txt')).resolves.toBeNull();
    // A plain file is not a symlink at all.
    await expect(secureFs.escapeTarget(worktree, 'real.txt')).resolves.toBeNull();
  });

  it('reports a plain file reached through a symlinked directory', async () => {
    const target = join(outside, 'notes.md');
    await writeFile(target, 'x', 'utf8');
    await symlink(outside, join(worktree, 'docs'));

    // The leaf is an ordinary file; the lie is one level up.
    await expect(secureFs.escapeTarget(worktree, 'docs/notes.md')).resolves.toBe(
      await realpath(target),
    );
  });

  it('does not report files when the worktree itself is reached through a symlink', async () => {
    await writeFile(join(worktree, 'real.txt'), 'x', 'utf8');
    const alias = join(outside, 'alias');
    await symlink(worktree, alias);

    await expect(secureFs.escapeTarget(alias, 'real.txt')).resolves.toBeNull();
  });

  it('reports nothing when the target cannot be resolved', async () => {
    await symlink(join(outside, 'never-created'), join(worktree, 'dangling.txt'));

    await expect(secureFs.escapeTarget(worktree, 'dangling.txt')).resolves.toBeNull();
    await expect(secureFs.escapeTarget(worktree, 'missing.txt')).resolves.toBeNull();
  });
});

/**
 * Deletion is the one containment failure that cannot be undone, and it is the only
 * secureFs operation whose guard differs by target kind: a symlink is removed as a
 * link, while anything else must prove its realpath is inside the worktree.
 */
describe('secureFs.delete containment', () => {
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'frink-secure-fs-del-wt-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-secure-fs-del-out-'));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('deletes a plain file inside the worktree', async () => {
    await writeFile(join(worktree, 'stale.txt'), 'x', 'utf8');

    await secureFs.delete(worktree, 'stale.txt');

    await expect(readFile(join(worktree, 'stale.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses to delete a file reached through a symlinked directory escaping the worktree', async () => {
    // The attack the guard exists for: `docs` looks like a repo folder but is a link out.
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'precious', 'utf8');
    await symlink(outside, join(worktree, 'docs'));

    await expect(secureFs.delete(worktree, join('docs', 'victim.txt'))).rejects.toThrow(
      PathValidationError,
    );
    await expect(readFile(victim, 'utf8')).resolves.toBe('precious');
  });

  it('deletes an escaping symlink itself without touching its target', async () => {
    const target = join(outside, 'target.txt');
    await writeFile(target, 'keep', 'utf8');
    const link = join(worktree, 'link.txt');
    await symlink(target, link);

    await secureFs.delete(worktree, 'link.txt');

    // The link is gone; the file it pointed at is untouched.
    await expect(lstat(link)).rejects.toThrow();
    await expect(readFile(target, 'utf8')).resolves.toBe('keep');
  });

  it('refuses to delete the worktree root itself', async () => {
    await writeFile(join(worktree, 'keep.txt'), 'x', 'utf8');

    await expect(secureFs.delete(worktree, '')).rejects.toThrow(PathValidationError);
    await expect(secureFs.delete(worktree, '.')).rejects.toThrow(PathValidationError);

    // The worktree and its contents survive.
    await expect(readFile(join(worktree, 'keep.txt'), 'utf8')).resolves.toBe('x');
  });

  it('is idempotent for a path that does not exist', async () => {
    await expect(secureFs.delete(worktree, 'never-existed.txt')).resolves.toBeUndefined();
  });
});
