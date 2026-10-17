import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { excludeFromGit } from './git-state';
import { resolveSecretTarget } from './targets';

let dir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'secret-target-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('resolveSecretTarget', () => {
  it('resolves .env inside the chat folder and reports an existing key', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'API_KEY=old\n');

    const target = await resolveSecretTarget(dir, '.env', 'API_KEY');

    expect(target).toEqual({
      target: path.join(dir, '.env'),
      rel: '.env',
      replaces: true,
      git: 'none',
    });
  });

  it('accepts an env file in an existing subfolder', async () => {
    await fs.mkdir(path.join(dir, 'apps', 'web'), { recursive: true });

    const target = await resolveSecretTarget(dir, 'apps/web/.env.local', 'API_KEY');

    expect(target.rel).toBe(path.join('apps', 'web', '.env.local'));
    expect(target.replaces).toBe(false);
  });

  it.each([
    ['../.env', 'must be a path inside the project'],
    ['/etc/.env', 'must be a path inside the project'],
    ['.env.example', 'is not an env file'],
    ['config.json', 'is not an env file'],
    ['missing/.env', 'does not exist in this project'],
  ])('refuses %s', async (file, message) => {
    await expect(resolveSecretTarget(dir, file, 'API_KEY')).rejects.toThrow(message);
  });

  it('refuses a .env that is a link, so a write cannot land outside the project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'real'), '');
      await fs.symlink(path.join(outside, 'real'), path.join(dir, '.env'));

      await expect(resolveSecretTarget(dir, '.env', 'API_KEY')).rejects.toThrow(
        'is a link or a folder',
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a subfolder that links outside the project', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'secret-outside-'));
    try {
      await fs.symlink(outside, path.join(dir, 'linked'));

      await expect(resolveSecretTarget(dir, 'linked/.env', 'API_KEY')).rejects.toThrow(
        'does not exist in this project',
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a chat with no project folder', async () => {
    await expect(resolveSecretTarget(os.homedir(), '.env', 'API_KEY')).rejects.toThrow(
      'Open this chat in a project folder',
    );
    await expect(resolveSecretTarget(undefined, '.env', 'API_KEY')).rejects.toThrow(
      'Open this chat in a project folder',
    );
  });

  it('reports how git treats the file', async () => {
    git(dir, 'init', '-q');
    expect((await resolveSecretTarget(dir, '.env', 'K')).git).toBe('untracked');

    await fs.writeFile(path.join(dir, '.gitignore'), '.env\n');
    expect((await resolveSecretTarget(dir, '.env', 'K')).git).toBe('ignored');

    await fs.writeFile(path.join(dir, '.env.local'), 'K=1\n');
    git(dir, 'add', '-f', '.env.local');
    expect((await resolveSecretTarget(dir, '.env.local', 'K')).git).toBe('tracked');
  });
});

// Pathspecs read `[id]` as a glob; a tracked file there must not pass for untracked, or the form
// would promise to keep a committed secret out of git.
it('reports a tracked file under a folder with glob characters as tracked', async () => {
  git(dir, 'init', '-q');
  await fs.mkdir(path.join(dir, 'apps', '[id]'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps', '[id]', '.env'), 'K=1\n');
  git(dir, 'add', '--', ':(literal)apps/[id]/.env');

  expect((await resolveSecretTarget(dir, 'apps/[id]/.env', 'K')).git).toBe('tracked');
});

describe('excludeFromGit', () => {
  // `[id]` is a glob class in gitignore syntax: unescaped, the line would ignore apps/i/.env instead.
  it('ignores the exact file when its folder name has glob characters', async () => {
    git(dir, 'init', '-q');
    await fs.mkdir(path.join(dir, 'apps', '[id]'), { recursive: true });

    await excludeFromGit(dir, path.join(dir, 'apps', '[id]', '.env'));

    expect((await resolveSecretTarget(dir, 'apps/[id]/.env', 'K')).git).toBe('ignored');
    await fs.mkdir(path.join(dir, 'apps', 'i'), { recursive: true });
    expect((await resolveSecretTarget(dir, 'apps/i/.env', 'K')).git).toBe('untracked');
  });

  it('ignores the file on this machine only, once, from a main checkout and a worktree', async () => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);

    await excludeFromGit(repo, path.join(repo, '.env'));
    await excludeFromGit(repo, path.join(repo, '.env'));
    await excludeFromGit(worktree, path.join(worktree, '.env.local'));

    const exclude = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line.startsWith('/.env'))).toEqual([
      '/.env',
      '/.env.local',
    ]);
    expect((await resolveSecretTarget(worktree, '.env.local', 'K')).git).toBe('ignored');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
