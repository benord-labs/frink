/** sc-3849: an ignored hook overlay (`.devkit/`) is linked whole, so a later `ln -sfn` cannot
 *  nest it and the gates' baselines resolve; husky's runner copy is unchanged. */

import { execSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInitGit } from '../test-utils';

import { configureWorktreeHooks, createWorktree } from './worktree';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Mirrors devkit's gate: fail closed when the grandfathering baselines cannot be read. */
const BASELINE_GATE =
  '#!/usr/bin/env sh\n[ -f .devkit/baselines/size.json ] || { echo "baselines missing" >&2; exit 1; }\n';

const tracked: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(dir = tmp('frink-overlay-repo-')): string {
  mkdirSync(dir, { recursive: true });
  const template = mkdtempSync(join(tmpdir(), 'frink-overlay-tpl-'));
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
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add README.md');
  git(dir, 'commit -m init');
  return dir;
}

/** devkit overlay mode: excluded `.devkit/` holding the hook runner plus gate baselines. */
function addDevkitOverlay(repo: string, overlayDir = join(repo, '.devkit')): void {
  mkdirSync(join(overlayDir, 'hooks'), { recursive: true });
  mkdirSync(join(overlayDir, 'baselines'), { recursive: true });
  writeFileSync(join(overlayDir, 'hooks/pre-commit'), BASELINE_GATE);
  chmodSync(join(overlayDir, 'hooks/pre-commit'), 0o755);
  writeFileSync(join(overlayDir, 'baselines/size.json'), '{"grandfathered":1}\n');
  if (overlayDir !== join(repo, '.devkit')) linkDir(overlayDir, join(repo, '.devkit'));
  mkdirSync(join(repo, '.git/info'), { recursive: true });
  writeFileSync(join(repo, '.git/info/exclude'), '/.devkit\n', { flag: 'a' });
  git(repo, 'config core.hooksPath .devkit/hooks');
}

/** Junctions need no privilege on Windows; elsewhere the type argument is ignored. */
const linkDir = (target: string, path: string): void => symlinkSync(target, path, 'junction');

/** The layout sc-3849 left behind: real `.devkit/` with a hooks copy and a nested link. */
function breakLikeSc3849(repo: string, wt: string): void {
  rmSync(join(wt, '.devkit'), { recursive: true, force: true });
  mkdirSync(join(wt, '.devkit'));
  cpSync(join(repo, '.devkit/hooks'), join(wt, '.devkit/hooks'), { recursive: true });
  linkDir(join(repo, '.devkit'), join(wt, '.devkit/.devkit'));
}

const isLinkTo = (path: string, target: string): boolean =>
  lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(target);

afterEach(() => {
  while (tracked.length > 0) {
    const d = tracked.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe.skipIf(!canInitGit)('worktree hook overlay provisioning (sc-3849)', () => {
  it('links the whole ignored overlay so baselines resolve, even with spaces in the main path', async () => {
    const repo = initRepo(join(tmp('frink-overlay-space-'), 'Personal and learning'));
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');

    await createWorktree(repo, 'feat-overlay', wt, 'main');

    expect(isLinkTo(join(wt, '.devkit'), join(repo, '.devkit'))).toBe(true);
    expect(existsSync(join(wt, '.devkit/baselines/size.json'))).toBe(true);
    expect(git(wt, 'status --porcelain')).toBe('');
  });

  // The maintainer setup script is POSIX shell; Windows has no `ln` to model.
  it.skipIf(process.platform === 'win32')(
    "stays a single link after the setup script's `ln -sfn` runs over it",
    async () => {
      const repo = initRepo();
      addDevkitOverlay(repo);
      const wt = join(tmp('frink-overlay-out-'), 'wt');
      await createWorktree(repo, 'feat-setup', wt, 'main');

      execSync(`ln -sfn "${join(repo, '.devkit')}" .devkit`, { cwd: wt });

      expect(isLinkTo(join(wt, '.devkit'), join(repo, '.devkit'))).toBe(true);
      expect(existsSync(join(repo, '.devkit/.devkit'))).toBe(false);
    },
  );

  it('lets a fresh worktree pass a baseline-requiring gate on `commit --allow-empty`', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');
    await createWorktree(repo, 'feat-commit', wt, 'main');

    expect(() => git(wt, 'commit --allow-empty -m empty')).not.toThrow();
  });

  it('links to a main overlay that is itself a symlink to a store outside the repo', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo, join(tmp('frink-overlay-store-'), 'devkit-store'));
    const wt = join(tmp('frink-overlay-out-'), 'wt');

    await createWorktree(repo, 'feat-store', wt, 'main');

    expect(isLinkTo(join(wt, '.devkit'), join(repo, '.devkit'))).toBe(true);
    expect(() => git(wt, 'commit --allow-empty -m empty')).not.toThrow();
  });

  it('keeps copying (never links) when the hooks dir is itself the ignored unit, as husky does', async () => {
    const repo = initRepo();
    mkdirSync(join(repo, '.husky/_'), { recursive: true });
    writeFileSync(join(repo, '.husky/_/pre-commit'), '#!/usr/bin/env sh\nexit 0\n');
    writeFileSync(join(repo, '.husky/.gitignore'), '_\n');
    git(repo, 'add .husky/.gitignore');
    git(repo, 'commit -m husky');
    git(repo, 'config core.hooksPath .husky/_');
    const wt = join(tmp('frink-overlay-out-'), 'wt');

    await createWorktree(repo, 'feat-husky', wt, 'main');

    expect(lstatSync(join(wt, '.husky')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, '.husky/_')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(wt, '.husky/_/pre-commit'))).toBe(true);
  });

  it('does not link an overlay that still has force-tracked files in main', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    writeFileSync(join(repo, '.devkit/config.json'), '{}\n');
    git(repo, 'add -f .devkit/config.json');
    git(repo, 'commit -m tracked-config');
    const wt = join(tmp('frink-overlay-out-'), 'wt');

    await createWorktree(repo, 'feat-partly-tracked', wt, 'main');

    expect(lstatSync(join(wt, '.devkit')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(wt, '.devkit/hooks/pre-commit'))).toBe(true);
  });

  it('never touches an existing real overlay dir, even the sc-3849 nested layout', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');
    await createWorktree(repo, 'feat-existing', wt, 'main');
    breakLikeSc3849(repo, wt);
    writeFileSync(join(wt, '.devkit/local-notes.md'), 'mine\n');

    await configureWorktreeHooks(repo, wt);

    expect(lstatSync(join(wt, '.devkit')).isDirectory()).toBe(true);
    expect(readFileSync(join(wt, '.devkit/local-notes.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(repo, '.devkit/baselines/size.json'))).toBe(true);
  });

  it('never copies hooks through an existing overlay link that points somewhere else', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');
    await createWorktree(repo, 'feat-foreign-link', wt, 'main');
    const elsewhere = tmp('frink-overlay-elsewhere-');
    rmSync(join(wt, '.devkit'));
    linkDir(elsewhere, join(wt, '.devkit'));

    await configureWorktreeHooks(repo, wt);

    expect(isLinkTo(join(wt, '.devkit'), elsewhere)).toBe(true);
    expect(existsSync(join(elsewhere, 'hooks'))).toBe(false);
  });

  it('converges when create-time wiring and startup wiring race on one worktree', async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');
    await createWorktree(repo, 'feat-race', wt, 'main');
    rmSync(join(wt, '.devkit'));

    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() => configureWorktreeHooks(repo, wt)),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(isLinkTo(join(wt, '.devkit'), join(repo, '.devkit'))).toBe(true);
    expect(existsSync(join(repo, '.devkit/.devkit'))).toBe(false);
  });

  it("removing the worktree leaves the main checkout's overlay intact", async () => {
    const repo = initRepo();
    addDevkitOverlay(repo);
    const wt = join(tmp('frink-overlay-out-'), 'wt');
    await createWorktree(repo, 'feat-teardown', wt, 'main');

    git(repo, `worktree remove --force "${wt}"`);

    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(repo, '.devkit/baselines/size.json'))).toBe(true);
    expect(existsSync(join(repo, '.devkit/hooks/pre-commit'))).toBe(true);
  });
});
