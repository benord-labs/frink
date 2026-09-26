/**
 * Worktrees must honour the main repo's git hooks. Husky pins a *relative* `core.hooksPath`
 * (`.husky/_`) whose runner is gitignored, so a fresh worktree has no runner and silently
 * skips every hook — commits bypass all gates. createWorktree wires this so hooks fire.
 *
 * These exercise the real git machinery (no mocks): the four hook setups a user can have,
 * plus the multi-pane (several worktrees) and spaces-in-path shapes that bite in practice.
 */

import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canInitGit } from '../test-utils';

import { configureWorktreeHooks, createWorktree, isFrinkManagedWorktree } from './worktree';

// Real git + multiple createWorktree calls (each spawns a login shell for env) run well
// past the 5s default once coverage instrumentation is layered on.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const RUNNER_H =
  '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s"\n';
const RUNNER_STUB = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
/** A pre-commit that drops a marker so a test can prove the hook actually ran. */
const MARKER_HOOK = '#!/usr/bin/env sh\necho fired > "$(pwd)/.hook-fired"\n';
const versionHook = (version: string): string =>
  `#!/usr/bin/env sh\necho ${version} > "$(pwd)/.hook-version"\n`;

const tracked: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString().trim();
}

/** Bare repo with one commit on `main`, no hooks configured. */
function initRepo(baseDir?: string): string {
  const dir = baseDir ?? tmp('frink-wt-hooks-repo-');
  if (baseDir) mkdirSync(dir, { recursive: true });
  const template = mkdtempSync(join(tmpdir(), 'frink-wt-hooks-tpl-'));
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

/** Add husky-style hooks: relative hooksPath + gitignored `_` runner + tracked hook. */
function addHusky(dir: string): void {
  mkdirSync(join(dir, '.husky/_'), { recursive: true });
  writeFileSync(join(dir, '.husky/_/h'), RUNNER_H);
  writeFileSync(join(dir, '.husky/_/pre-commit'), RUNNER_STUB);
  writeFileSync(join(dir, '.husky/pre-commit'), MARKER_HOOK);
  writeFileSync(join(dir, '.husky/.gitignore'), '_\n');
  for (const f of ['.husky/_/h', '.husky/_/pre-commit', '.husky/pre-commit'])
    chmodSync(join(dir, f), 0o755);
  git(dir, 'config core.hooksPath .husky/_');
  git(dir, 'add .husky/pre-commit .husky/.gitignore');
  git(dir, 'commit -m husky');
}

/** Make a commit inside the worktree; the marker hook drops `.hook-fired` if it ran. */
function commitInWorktree(wt: string): void {
  writeFileSync(join(wt, 'README.md'), `changed-${Math.random()}\n`);
  git(wt, 'add README.md');
  git(wt, 'commit -m c');
}
const hookFired = (wt: string): boolean => existsSync(join(wt, '.hook-fired'));

afterEach(() => {
  while (tracked.length > 0) {
    const d = tracked.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
  vi.restoreAllMocks();
});

describe.skipIf(!canInitGit)('createWorktree hook wiring (git integration)', () => {
  it('marks only Frink-created worktrees as managed in worktree scope', async () => {
    const repo = initRepo();
    git(repo, 'config frink.managed true'); // broader-scope lookalike must not authorize deletion
    const base = tmp('frink-wt-hooks-out-');
    const manualWt = join(base, 'manual');
    const frinkWt = join(base, 'frink');

    git(repo, `worktree add ${manualWt} -b manual-worktree main`);
    expect(await isFrinkManagedWorktree(manualWt)).toBe(false);

    await createWorktree(repo, 'frink-worktree', frinkWt, 'main');

    expect(await isFrinkManagedWorktree(manualWt)).toBe(false);
    expect(await isFrinkManagedWorktree(frinkWt)).toBe(true);
  });

  it('preserves bare-repository-backed manual worktrees when ownership cannot be marked safely', async () => {
    const source = initRepo();
    const bare = tmp('frink-wt-hooks-bare-');
    const project = join(tmp('frink-wt-hooks-project-'), 'project');
    const manualWt = join(tmp('frink-wt-hooks-manual-'), 'manual');
    const frinkWt = join(tmp('frink-wt-hooks-out-'), 'frink');

    execSync(`git clone --bare ${source} ${bare}`, { stdio: 'pipe' });
    git(bare, `worktree add ${project} main`);
    git(bare, `worktree add -b manual-worktree ${manualWt} main`);

    await createWorktree(project, 'frink-worktree', frinkWt, 'main');

    expect(() => git(project, 'status --porcelain')).not.toThrow();
    expect(() => git(manualWt, 'status --porcelain')).not.toThrow();
    expect(await isFrinkManagedWorktree(frinkWt)).toBe(false);
  });

  it('preserves core.worktree-backed manual worktrees when ownership cannot be marked safely', async () => {
    const source = initRepo();
    const superRepo = initRepo();
    const project = join(superRepo, 'lib');
    const manualWt = join(tmp('frink-wt-hooks-manual-'), 'manual');
    const frinkWt = join(tmp('frink-wt-hooks-out-'), 'frink');

    git(superRepo, `-c protocol.file.allow=always submodule add ${source} lib`);
    git(superRepo, 'commit -am submodule');
    git(project, `worktree add -b manual-worktree ${manualWt} main`);
    const projectTopLevel = execSync('git rev-parse --show-toplevel', {
      cwd: project,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    const manualTopLevel = execSync('git rev-parse --show-toplevel', {
      cwd: manualWt,
      stdio: 'pipe',
    })
      .toString()
      .trim();

    await createWorktree(project, 'frink-worktree', frinkWt, 'main');

    expect(
      execSync('git rev-parse --show-toplevel', { cwd: project, stdio: 'pipe' }).toString().trim(),
    ).toBe(projectTopLevel);
    expect(
      execSync('git rev-parse --show-toplevel', { cwd: manualWt, stdio: 'pipe' }).toString().trim(),
    ).toBe(manualTopLevel);
    expect(await isFrinkManagedWorktree(frinkWt)).toBe(false);
  });

  it('wires husky (relative, gitignored runner) so hooks fire in the worktree', async () => {
    const repo = initRepo();
    addHusky(repo);
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-husky', wt, 'main');

    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
    expect(existsSync(join(wt, '.husky/_/h'))).toBe(true);
    commitInWorktree(wt);
    expect(hookFired(wt)).toBe(true);
  });

  it('runs the checked-out hook body when the primary checkout has newer hooks', async () => {
    const repo = initRepo();
    addHusky(repo);
    writeFileSync(join(repo, '.husky/pre-commit'), versionHook('old-checkout'));
    git(repo, 'add .husky/pre-commit');
    git(repo, 'commit -m old-hook');
    const oldCommit = execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' })
      .toString()
      .trim();

    writeFileSync(join(repo, '.husky/pre-commit'), versionHook('primary-checkout'));
    git(repo, 'add .husky/pre-commit');
    git(repo, 'commit -m new-hook');
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-stale-hooks', wt, oldCommit);
    commitInWorktree(wt);

    expect(readFileSync(join(wt, '.hook-version'), 'utf8').trim()).toBe('old-checkout');
  });

  it("repairs Frink's legacy absolute override without touching the checked-out hook body", async () => {
    const repo = initRepo();
    addHusky(repo);
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');
    await createWorktree(repo, 'feat-legacy-hooks', wt, 'main');
    git(repo, 'config extensions.worktreeConfig true');
    git(wt, `config --worktree core.hooksPath ${join(repo, '.husky/_')}`);

    await configureWorktreeHooks(repo, wt);

    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
    commitInWorktree(wt);
    expect(hookFired(wt)).toBe(true);
  });

  it('preserves a user-defined worktree-local hooksPath', async () => {
    const repo = initRepo();
    addHusky(repo);
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');
    const customHooksPath = join(wt, '.custom-hooks');
    await createWorktree(repo, 'feat-custom-hooks', wt, 'main');
    git(wt, `config --worktree core.hooksPath ${customHooksPath}`);

    await configureWorktreeHooks(repo, wt);

    expect(git(wt, 'config --worktree --get core.hooksPath')).toBe(customHooksPath);
  });

  it('fails closed instead of falling back to a cross-checkout hook path', async () => {
    const repo = initRepo();
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');
    git(repo, `worktree add ${wt} -b unsafe-hooks main`);
    git(repo, 'config core.hooksPath ../outside-repo');

    await expect(configureWorktreeHooks(repo, wt)).rejects.toThrow(
      'Refusing to copy git hooks from outside the repository',
    );
    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
  });

  it('rolls back the worktree and branch when runner installation fails', async () => {
    const repo = initRepo();
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');
    git(repo, 'config core.hooksPath ../outside-repo');

    await expect(createWorktree(repo, 'failed-hook-install', wt, 'main')).rejects.toThrow(
      'Refusing to copy git hooks from outside the repository',
    );

    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'worktree list --porcelain')).not.toContain(wt);
    expect(git(repo, 'branch --list failed-hook-install')).toBe('');
  });

  it('leaves plain .git/hooks (unset hooksPath) untouched — already shared via common dir', async () => {
    const repo = initRepo();
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-plain', wt, 'main');

    // Early-return: nothing wired (a worktree-local value would mean we over-reached).
    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
  });

  it('leaves an absolute hooksPath untouched — inherited verbatim by the worktree', async () => {
    const repo = initRepo();
    git(repo, `config core.hooksPath ${join(repo, '.abshooks')}`);
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-abs', wt, 'main');

    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
  });

  it('leaves a relative, TRACKED hooksPath untouched — present in the worktree checkout', async () => {
    const repo = initRepo();
    mkdirSync(join(repo, '.githooks'));
    writeFileSync(join(repo, '.githooks/pre-commit'), MARKER_HOOK);
    chmodSync(join(repo, '.githooks/pre-commit'), 0o755);
    git(repo, 'config core.hooksPath .githooks');
    git(repo, 'add .githooks/pre-commit');
    git(repo, 'commit -m githooks');
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-tracked', wt, 'main');

    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
    // ...and it still fires natively because the tracked dir is checked out.
    commitInWorktree(wt);
    expect(hookFired(wt)).toBe(true);
  });

  it('multi-pane: independent worktrees each get wired and fire without interfering', async () => {
    const repo = initRepo();
    addHusky(repo);
    const base = tmp('frink-wt-hooks-out-');
    const wtA = join(base, 'a');
    const wtB = join(base, 'b');

    await createWorktree(repo, 'feat-a', wtA, 'main');
    await createWorktree(repo, 'feat-b', wtB, 'main');

    expect(() => git(wtA, 'config --worktree --get core.hooksPath')).toThrow();
    expect(() => git(wtB, 'config --worktree --get core.hooksPath')).toThrow();
    commitInWorktree(wtA);
    commitInWorktree(wtB);
    expect(hookFired(wtA)).toBe(true);
    expect(hookFired(wtB)).toBe(true);
  });

  it('handles a main repo path containing spaces (real-world: "Personal and learning")', async () => {
    const repo = initRepo(join(tmp('frink-wt-hooks-space-'), 'has space repo'));
    addHusky(repo);
    const wt = join(tmp('frink-wt-hooks-out-'), 'wt');

    await createWorktree(repo, 'feat-space', wt, 'main');

    expect(() => git(wt, 'config --worktree --get core.hooksPath')).toThrow();
    commitInWorktree(wt);
    expect(hookFired(wt)).toBe(true);
  });
});
