import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';

const execFileAsync = promisify(execFile);

/**
 * Only a SUCCESSFUL resolution is cached: a hit cannot go stale (the git install does not move
 * while the app runs), but caching a miss would pin a session to cmd.exe even after the user
 * installs Git for Windows. A miss re-probes, which costs one `where git` per command on a box
 * that has no git — a broken setup for a git-worktree tool anyway.
 */
let cachedWindowsShell: string | undefined;
let warnedMissing = false;

const LINE_SPLIT_REGEX = /\r?\n/;

/**
 * Report the degraded mode. Falling back to cmd.exe is silent by design — commands still run,
 * they just half-succeed on POSIX syntax — so without a capture a Windows user's setup breaks
 * exactly as it did before this module existed, and nothing surfaces it. Lazy import keeps
 * @sentry/electron out of this module's static graph.
 */
function reportMissingGitBash(): void {
  log.warn(
    '[command-shell] Git Bash not found next to the git binary — commands fall back to cmd.exe, ' +
      'where POSIX syntax such as `cp` and `$VAR` will not run.',
  );
  void import('../sentry/init')
    .then(({ captureMainMessage }) => {
      captureMainMessage(
        'Git Bash not found on Windows; commands fall back to cmd.exe',
        'warning',
        { surface: 'command-shell' },
      );
    })
    .catch(() => {});
}

/**
 * Locate the Git Bash that ships with Git for Windows, via the git binary on PATH.
 * `where git` yields e.g. `C:\Program Files\Git\cmd\git.exe`, whose sibling is `..\bin\bash.exe`
 * — the same derivation VS Code uses for its Git Bash terminal profile.
 */
async function findGitBash(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('where', ['git'], { timeout: 5000 });
    for (const line of stdout.split(LINE_SPLIT_REGEX)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // win32 explicitly: these are Windows paths regardless of the host `node:path` flavour.
      const bash = win32.join(win32.dirname(win32.dirname(gitExe)), 'bin', 'bash.exe');
      if (existsSync(bash)) return bash;
    }
  } catch {
    // git absent from PATH; the caller falls back to the platform default.
  }
  return undefined;
}

/**
 * Shell for running user-authored command strings.
 *
 * Node's `exec` picks the shell from the platform: `/bin/sh` on POSIX, `%ComSpec%` (cmd.exe) on
 * Windows. cmd.exe runs neither `cp` nor `$VAR`, both of which Frink's own worktree setup docs and
 * the Fill-with-AI prompt generate, so the same command string that works on macOS half-fails on
 * Windows. Resolving Git Bash there — from the git install Frink already requires — makes one
 * command string behave the same on every platform.
 *
 * Returns `undefined` to mean "use Node's default". On POSIX that default already IS `/bin/sh`,
 * so this is a no-op outside Windows.
 */
export async function resolveCommandShell(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  if (cachedWindowsShell) return cachedWindowsShell;

  cachedWindowsShell = await findGitBash();
  if (!cachedWindowsShell && !warnedMissing) {
    warnedMissing = true;
    reportMissingGitBash();
  }
  return cachedWindowsShell;
}

/** Test-only: clears the per-session cache so platform can be re-stubbed. */
export function resetCommandShellCache(): void {
  cachedWindowsShell = undefined;
  warnedMissing = false;
}
