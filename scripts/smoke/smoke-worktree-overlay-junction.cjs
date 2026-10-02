/**
 * Windows smoke: removing a worktree must unlink its `.devkit` junction, never empty main's overlay.
 *
 * `linkOverlay` (src/main/lib/git/worktree/overlay.ts) links devkit's ignored overlay into each
 * worktree, as a junction on win32. Two removal paths then meet that junction: `git worktree remove
 * --force` (removeWorktree) and Node's recursive `fs.rm` (reclaimIfOrphan in
 * src/main/lib/trpc/routers/chats/teardown-worktree.ts). If either recursed through the reparse
 * point, it would delete the main checkout's gate baselines. The vitest suite only runs on POSIX,
 * so this asserts the ENVIRONMENT assumption on the windows-2022 job. It deliberately does not
 * import the runtime: it creates the junction itself. On POSIX the junction type is ignored and a
 * plain symlink is checked, which keeps it runnable locally.
 */
const { execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

function mainWithOverlay(label) {
  const repo = mkdtempSync(join(tmpdir(), `frink-overlay-smoke-${label}-`));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'smoke@frink');
  git(repo, 'config', 'user.name', 'smoke');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, '.devkit', 'hooks'), { recursive: true });
  mkdirSync(join(repo, '.devkit', 'baselines'), { recursive: true });
  writeFileSync(join(repo, '.devkit', 'baselines', 'size.json'), '{}\n');
  writeFileSync(join(repo, '.devkit', 'hooks', 'pre-commit'), '#!/usr/bin/env sh\nexit 0\n');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '/.devkit\n', { flag: 'a' });

  const wt = join(mkdtempSync(join(tmpdir(), `frink-overlay-smoke-wt-${label}-`)), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', `smoke-${label}`, wt, 'main');
  symlinkSync(join(repo, '.devkit'), join(wt, '.devkit'), 'junction');
  return { repo, wt };
}

function assertOverlayIntact(repo, how) {
  for (const file of [join('baselines', 'size.json'), join('hooks', 'pre-commit')]) {
    if (!existsSync(join(repo, '.devkit', file))) {
      fail(`${how} followed the .devkit junction and deleted main's .devkit/${file}`);
    }
  }
}

const viaGit = mainWithOverlay('git');
try {
  git(viaGit.repo, 'worktree', 'remove', '--force', viaGit.wt);
} catch (error) {
  fail(`git worktree remove --force failed on a junctioned worktree: ${error.message}`);
}
assertOverlayIntact(viaGit.repo, 'git worktree remove --force');

const viaRm = mainWithOverlay('rm');
rmSync(viaRm.wt, { recursive: true, force: true });
assertOverlayIntact(viaRm.repo, 'fs.rm recursive');

console.log("smoke-worktree-overlay-junction: worktree removal leaves main's overlay intact ✓");
