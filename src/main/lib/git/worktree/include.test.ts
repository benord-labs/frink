/**
 * Which gitignored files a new worktree receives, and how they are copied. Real git repos, no
 * mocks: the behaviour lives in git's own ignore rules and `ls-files --directory` collapsing.
 */

import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInitGit } from '../../test-utils';
import {
  copyPlannedFiles,
  copyWorktreeIncludes,
  resolveWorktreeIncludes,
  setWorktreeCopyEnabled,
} from './include';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tracked: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
}

function write(root: string, rel: string, content = 'x\n'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * A repo with `gitignore` and `trackedFiles` committed; `files` are written afterwards and stay
 * untracked (ignored or not, as the rules decide).
 */
function initRepo(opts: {
  gitignore: string;
  trackedFiles?: string[];
  files?: Record<string, string>;
  include?: string;
}): string {
  // A space in the path, like the real checkouts this runs against.
  const dir = tmp('frink wt include repo-');
  const template = mkdtempSync(join(tmpdir(), 'frink-wt-include-tpl-'));
  try {
    execSync('git init -b main', {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_TEMPLATE_DIR: template },
    });
  } finally {
    rmSync(template, { recursive: true, force: true });
  }
  git(dir, 'config user.email t@t');
  git(dir, 'config user.name t');
  write(dir, '.gitignore', opts.gitignore);
  for (const rel of opts.trackedFiles ?? []) write(dir, rel);
  if (opts.include !== undefined) write(dir, '.worktreeinclude', opts.include);
  git(dir, 'add -A');
  git(dir, 'commit -m init');
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(dir, rel, content);
  return dir;
}

/** A real worktree of `repo` at its HEAD, so the copy can check the worktree's own ignore rules. */
function worktreeOf(repo: string): string {
  const dest = join(tmp('frink-wt-include-dest-'), 'wt');
  git(repo, `worktree add --detach "${dest}"`);
  return dest;
}

/** Every untracked file in a worktree, which right after creation is exactly what was copied. */
function untrackedFiles(worktree: string): string[] {
  return git(worktree, 'ls-files --others').split('\n').filter(Boolean).sort();
}

afterEach(() => {
  while (tracked.length > 0) {
    const dir = tracked.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!canInitGit)('resolveWorktreeIncludes (git integration)', () => {
  it('defaults to ignored .env files at any depth, never templates or tracked files', async () => {
    const repo = initRepo({
      gitignore: '.env*\n',
      trackedFiles: ['apps/web/index.ts'],
      files: {
        '.env': 'A=1\n',
        '.envrc': 'use nix\n',
        '.env.sample': 'A=\n',
        'apps/web/.env.local': 'B=1\n',
      },
    });
    write(repo, '.env.shared');
    git(repo, 'add -f .env.shared');
    git(repo, 'commit -m shared');

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.source).toBe('default');
    expect(plan.files).toEqual(['.env', '.envrc', 'apps/web/.env.local']);
  });

  it('never opens a .env directory for the default, such as a Python virtualenv', async () => {
    const repo = initRepo({
      gitignore: '.env\n.envrc\n',
      files: { '.env/bin/python': 'binary\n', '.envrc': 'layout python\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['.envrc']);
  });

  // The example in user-docs/worktree-setup.md "Worktrees an agent makes itself".
  it('copies the same .env files as the default with the documented .worktreeinclude', async () => {
    const repo = initRepo({
      gitignore: '.env\n.env.*\n',
      trackedFiles: ['apps/web/index.ts'],
      include: '.env*\n!.env*/\n',
      files: {
        '.env.local': 'A=1\n',
        'apps/web/.env': 'B=1\n',
        '.env/bin/python': 'binary\n',
      },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.source).toBe('worktreeinclude');
    expect(plan.files).toEqual(['.env.local', 'apps/web/.env']);
  });

  it('uses .worktreeinclude instead of the default when the repo has one', async () => {
    const repo = initRepo({
      gitignore: '.env\nconfig/local.json\n',
      trackedFiles: ['config/app.json'],
      include: 'config/local.json\n',
      files: { '.env': 'A=1\n', 'config/local.json': '{}\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.source).toBe('worktreeinclude');
    expect(plan.files).toEqual(['config/local.json']);
  });

  it('copies only ignored files a pattern matches, never tracked or untracked-unignored ones', async () => {
    const repo = initRepo({
      gitignore: 'cache.json\n',
      trackedFiles: ['package.json'],
      include: '*.json\n',
      files: { 'scratch.json': '{}\n', 'cache.json': '{}\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['cache.json']);
  });

  it('honours negation in .worktreeinclude', async () => {
    const repo = initRepo({
      gitignore: '.env*\n',
      trackedFiles: ['apps/web/index.ts', 'packages/legacy/index.ts'],
      include: '**/.env*\n!packages/legacy/.env\n',
      files: { 'apps/web/.env': 'A=1\n', 'packages/legacy/.env': 'B=1\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['apps/web/.env']);
  });

  it('opens an ignored directory only when .worktreeinclude reaches into it', async () => {
    const repo = initRepo({
      gitignore: '.vscode/\nnode_modules/\nsecrets/\n',
      include: '.vscode/\nsecrets/dev/*.pem\n!secrets/dev/skip.pem\n',
      files: {
        '.vscode/settings.json': '{}\n',
        'node_modules/pkg/index.js': 'x\n',
        'secrets/dev/a.pem': 'pem\n',
        'secrets/dev/skip.pem': 'pem\n',
        'secrets/prod/b.pem': 'pem\n',
      },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['.vscode/settings.json', 'secrets/dev/a.pem']);
  });

  it('reaches a wholly ignored folder nested below a glob path', async () => {
    const repo = initRepo({
      gitignore: 'config/local/\n',
      trackedFiles: ['config/app.json'],
      include: 'config/**/*.json\n',
      files: { 'config/local/dev.json': '{}\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['config/local/dev.json']);
  });

  // Windows editors save UTF-8 with a byte-order mark and CRLF; neither may hide a pattern's path.
  it('opens an ignored directory named on the first line of a BOM-prefixed, CRLF file', async () => {
    const repo = initRepo({
      gitignore: 'secrets/\n',
      include: '﻿secrets/dev/*.pem\r\n',
      files: { 'secrets/dev/a.pem': 'pem\n' },
    });

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.files).toEqual(['secrets/dev/a.pem']);
  });

  it('skips files over 5 MB and stops at the file-count cap', async () => {
    const repo = initRepo({ gitignore: '.env*\ngen/\n', include: '.env*\ngen/\n' });
    write(repo, '.env.big', 'x'.repeat(6 * 1024 * 1024));
    for (let i = 0; i < 1005; i++) write(repo, `gen/f${String(i).padStart(4, '0')}.txt`);

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.skipped).toEqual([{ path: '.env.big', reason: 'too-large' }]);
    expect(plan.files).toHaveLength(1000);
    expect(plan.overLimit).toBe(5);
  });

  it('copies a file of exactly 5 MB and stops once the total would pass 50 MB', async () => {
    const repo = initRepo({ gitignore: 'models/\n', include: 'models/\n' });
    const fiveMb = 'x'.repeat(5 * 1024 * 1024);
    for (let i = 0; i < 11; i++) write(repo, `models/m${String(i).padStart(2, '0')}.bin`, fiveMb);

    const plan = await resolveWorktreeIncludes(repo);

    expect(plan.skipped).toEqual([]);
    expect(plan.files).toHaveLength(10);
    expect(plan.overLimit).toBe(1);
  });

  it('treats a listed file missing from the main checkout as nothing to copy', async () => {
    const repo = initRepo({ gitignore: 'config/\n', include: 'config/missing.json\n' });

    const plan = await resolveWorktreeIncludes(repo);
    const result = await copyWorktreeIncludes(repo, worktreeOf(repo));

    expect(plan.files).toEqual([]);
    expect(result).toEqual({ copied: 0, alreadyPresent: 0, failed: 0, notIgnored: 0 });
  });

  // Creating a symlink on Windows needs admin rights or Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'skips a .env.example that links to .env so secrets never land in a readable template',
    async () => {
      const repo = initRepo({
        gitignore: '.env*\n',
        include: '.env*\n',
        files: { '.env': 'S=1\n' },
      });
      symlinkSync('.env', join(repo, '.env.example'));

      const plan = await resolveWorktreeIncludes(repo);

      expect(plan.files).toEqual(['.env']);
      expect(plan.skipped).toEqual([{ path: '.env.example', reason: 'symlink' }]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'skips a link to a file outside the repository and copies one that stays inside',
    async () => {
      const outside = tmp('frink-wt-include-outside-');
      write(outside, 'id_rsa', 'PRIVATE\n');
      const repo = initRepo({
        gitignore: 'local.json\nshared/\n.env.local\n',
        include: 'local.json\n.env.local\n',
        files: { 'shared/app.env': 'A=1\n' },
      });
      symlinkSync(join(outside, 'id_rsa'), join(repo, 'local.json'));
      symlinkSync('shared/app.env', join(repo, '.env.local'));

      const plan = await resolveWorktreeIncludes(repo);

      expect(plan.files).toEqual(['.env.local']);
      expect(plan.skipped).toEqual([{ path: 'local.json', reason: 'symlink' }]);
    },
  );

  it('works from the repo top level when the project is a subfolder', async () => {
    const repo = initRepo({
      gitignore: '.env*\n',
      trackedFiles: ['apps/web/index.ts'],
      files: { '.env': 'A=1\n', 'apps/web/.env': 'B=1\n' },
    });

    const plan = await resolveWorktreeIncludes(join(repo, 'apps/web'));

    expect(plan.repoRoot).toBe(realpathSync(repo));
    expect(plan.files).toEqual(['.env', 'apps/web/.env']);
  });

  it('returns an empty plan instead of throwing outside a git repo', async () => {
    const plan = await resolveWorktreeIncludes(tmp('frink-wt-include-norepo-'));

    expect(plan).toMatchObject({ files: [], repoRoot: null });
  });
});

describe.skipIf(!canInitGit)('copyWorktreeIncludes (git integration)', () => {
  it('copies to the same relative path, keeps the mode, and never overwrites', async () => {
    const repo = initRepo({
      gitignore: '.env*\n',
      trackedFiles: ['apps/web/index.ts'],
      files: { '.env': 'main\n', 'apps/web/.env.local': 'B=1\n' },
    });
    chmodSync(join(repo, 'apps/web/.env.local'), 0o600);
    const dest = worktreeOf(repo);
    write(dest, '.env', 'worktree\n');

    const result = await copyWorktreeIncludes(repo, dest);

    expect(result).toEqual({ copied: 1, alreadyPresent: 1, failed: 0, notIgnored: 0 });
    expect(readFileSync(join(dest, '.env'), 'utf8')).toBe('worktree\n');
    expect(readFileSync(join(dest, 'apps/web/.env.local'), 'utf8')).toBe('B=1\n');
    if (process.platform !== 'win32') {
      expect(statSync(join(dest, 'apps/web/.env.local')).mode & 0o777).toBe(0o600);
    }
  });

  // An unreadable file must be counted and skipped, never thrown out of worktree creation.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts a file it cannot read as failed and still copies the rest',
    async () => {
      const repo = initRepo({
        gitignore: '.env*\n',
        files: { '.env': 'A=1\n', '.env.local': 'B=1\n' },
      });
      chmodSync(join(repo, '.env.local'), 0o000);
      const dest = worktreeOf(repo);

      const result = await copyWorktreeIncludes(repo, dest);

      expect(result).toEqual({ copied: 1, alreadyPresent: 0, failed: 1, notIgnored: 0 });
      expect(readFileSync(join(dest, '.env'), 'utf8')).toBe('A=1\n');
    },
  );

  it('copies exactly the files the settings preview lists', async () => {
    const repo = initRepo({
      gitignore: '.env*\n.vscode/\n',
      include: '.env*\n.vscode/\n',
      files: { '.env': 'A=1\n', '.env.test': 'B=1\n', '.vscode/settings.json': '{}\n' },
    });
    const dest = worktreeOf(repo);

    const plan = await resolveWorktreeIncludes(repo);
    await copyWorktreeIncludes(repo, dest);

    expect(untrackedFiles(dest)).toEqual(plan.files);
  });

  // A secret the main checkout ignores only through an uncommitted .gitignore edit would be an
  // ordinary new file in the worktree, which an agent's `git add -A` commits and pushes.
  it("leaves out a file the new worktree's own ignore rules don't cover", async () => {
    const repo = initRepo({
      gitignore: '.env\n',
      include: '.env\nlocal.json\n',
      files: { '.env': 'A=1\n', 'local.json': '{"key":"secret"}\n' },
    });
    const dest = worktreeOf(repo);
    write(repo, '.gitignore', '.env\nlocal.json\n');

    const result = await copyWorktreeIncludes(repo, dest);

    expect(result).toEqual({ copied: 1, alreadyPresent: 0, failed: 0, notIgnored: 1 });
    expect(existsSync(join(dest, 'local.json'))).toBe(false);
    expect(untrackedFiles(dest)).toEqual(['.env']);
  });

  // Paths reach git through stdin, NUL-separated: on the command line a long list breaks Windows'
  // 32 KB limit, and git quotes a name with a double quote, which then never matches.
  it.skipIf(process.platform === 'win32')('copies a file whose name git would quote', async () => {
    const repo = initRepo({
      gitignore: 'local*\n',
      include: 'local*\n',
      files: { 'local."q".json': '{}\n' },
    });
    const dest = worktreeOf(repo);

    const result = await copyWorktreeIncludes(repo, dest);

    expect(result).toEqual({ copied: 1, alreadyPresent: 0, failed: 0, notIgnored: 0 });
    expect(readFileSync(join(dest, 'local."q".json'), 'utf8')).toBe('{}\n');
  });

  it('copies nothing while the switch is off, and copies again once it is back on', async () => {
    const repo = initRepo({ gitignore: '.env\n', files: { '.env': 'A=1\n' } });

    await setWorktreeCopyEnabled(repo, false);
    const offPlan = await resolveWorktreeIncludes(repo);
    const offDest = worktreeOf(repo);
    const offResult = await copyWorktreeIncludes(repo, offDest);

    expect(offPlan).toMatchObject({ enabled: false, files: ['.env'] });
    expect(offResult.copied).toBe(0);
    expect(existsSync(join(offDest, '.env'))).toBe(false);

    await setWorktreeCopyEnabled(repo, true);
    const onDest = worktreeOf(repo);
    await copyWorktreeIncludes(repo, onDest);

    expect(readFileSync(join(onDest, '.env'), 'utf8')).toBe('A=1\n');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file swapped for a link out of the repository after the plan was made',
    async () => {
      const outside = tmp('frink-wt-include-outside-');
      write(outside, 'id_rsa', 'PRIVATE\n');
      const repo = initRepo({ gitignore: '.env\n', files: { '.env': 'A=1\n' } });
      const plan = await resolveWorktreeIncludes(repo);
      rmSync(join(repo, '.env'));
      symlinkSync(join(outside, 'id_rsa'), join(repo, '.env'));
      const dest = worktreeOf(repo);

      const result = await copyPlannedFiles(plan, dest);

      expect(result).toEqual({ copied: 0, alreadyPresent: 0, failed: 1, notIgnored: 0 });
      expect(existsSync(join(dest, '.env'))).toBe(false);
    },
  );

  // Copying runs after the worktree exists, so a throw here would report a created worktree as failed.
  it('copies nothing, without throwing, when the main checkout is gone by copy time', async () => {
    const repo = initRepo({ gitignore: '.env\n', files: { '.env': 'A=1\n' } });
    const plan = await resolveWorktreeIncludes(repo);
    const dest = worktreeOf(repo);

    const result = await copyPlannedFiles({ ...plan, repoRoot: join(repo, 'gone') }, dest);

    expect(result).toEqual({ copied: 0, alreadyPresent: 0, failed: 0, notIgnored: 0 });
  });

  // git exits before reading stdin when the destination isn't a repo. The unread input must not
  // surface as an unhandled stream error, which would crash the main process.
  it('survives git exiting before it reads a long path list', async () => {
    const repo = initRepo({ gitignore: 'gen/\n', include: 'gen/\n' });
    const longName = 'x'.repeat(150);
    for (let i = 0; i < 1000; i++) write(repo, `gen/${longName}${i}`);

    const result = await copyWorktreeIncludes(repo, tmp('frink-wt-include-plain-'));

    expect(result).toEqual({ copied: 0, alreadyPresent: 0, failed: 0, notIgnored: 1000 });
  });

  it('copies nothing when the destination is not a git worktree', async () => {
    const repo = initRepo({ gitignore: '.env\n', files: { '.env': 'A=1\n' } });
    const dest = tmp('frink-wt-include-plain-');

    const result = await copyWorktreeIncludes(repo, dest);

    expect(result).toEqual({ copied: 0, alreadyPresent: 0, failed: 0, notIgnored: 1 });
  });
});
