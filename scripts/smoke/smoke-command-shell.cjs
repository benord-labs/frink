/**
 * Windows smoke: prove a POSIX command string actually RUNS on a real Windows runner.
 *
 * `resolveCommandShell` (src/main/lib/platform/command-shell.ts) is unit-tested with a stubbed
 * platform, which can only prove the derivation arithmetic. It cannot prove the two environment
 * assumptions the whole approach rests on: that Git for Windows puts `bash.exe` beside the `git`
 * on PATH, and that `cp`/`$VAR` behave there as they do on macOS. Only a Windows machine can, so
 * this runs in the windows-2022 job.
 *
 * Deliberately mirrors the runtime derivation rather than importing it: the point is to assert the
 * ENVIRONMENT still matches what the runtime assumes, so a runner-image change that moved bash.exe
 * would fail here instead of shipping.
 */
const { execFileSync, execSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { win32 } = require('node:path');

if (process.platform !== 'win32') {
  console.log('smoke-command-shell: not win32 — skipping');
  process.exit(0);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const found = execFileSync('where', ['git'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const bash = found
  .map((gitExe) => win32.join(win32.dirname(win32.dirname(gitExe)), 'bin', 'bash.exe'))
  .find((candidate) => existsSync(candidate));

if (!bash) {
  fail(`no bash.exe beside any git on PATH (checked: ${found.join(', ')})`);
}
console.log(`smoke-command-shell: resolved ${bash}`);

// The exact shape Frink's own worktree config and Fill-with-AI prompt generate: a `cp` with an
// env-var reference, chained with &&. Under cmd.exe this half-succeeds — `cp` is unrecognised and
// $ROOT_WORKTREE_PATH never expands — which is the bug this shell selection exists to fix.
const dir = mkdtempSync(win32.join(tmpdir(), 'frink-shell-smoke-'));
writeFileSync(win32.join(dir, '.env'), 'SMOKE=ok\n');
const worktree = mkdtempSync(win32.join(tmpdir(), 'frink-shell-smoke-wt-'));

try {
  execSync('echo staged && cp $ROOT_WORKTREE_PATH/.env .env', {
    cwd: worktree,
    shell: bash,
    env: { ...process.env, ROOT_WORKTREE_PATH: dir },
    stdio: 'pipe',
  });
} catch (error) {
  fail(`POSIX command string failed under Git Bash: ${error.message}`);
}

const copied = win32.join(worktree, '.env');
if (!existsSync(copied) || !readFileSync(copied, 'utf8').includes('SMOKE=ok')) {
  fail('command reported success but .env was not copied — $VAR likely did not expand');
}

console.log('smoke-command-shell: POSIX command string ran correctly under Git Bash ✓');
