import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { platform as platformProvider } from '../platform';
import { resolveLoginShellEnv, type ShellEnv } from '../platform/login-shell-env';

const execFileAsync = promisify(execFile);

/**
 * Gets the full shell environment with proper PATH for all platforms.
 *
 * - **Windows**: Derives PATH from process.env + common install locations (no shell spawn)
 * - **macOS/Linux**: The shared login-shell environment (see platform/login-shell-env)
 *
 * This captures PATH and other environment variables needed to find user-installed tools
 * like git-lfs (homebrew on macOS) or Claude CLI (user-local on Windows).
 */
async function getShellEnvironment(): Promise<ShellEnv> {
  // Windows: derive PATH without shell invocation
  // Git Bash PATH doesn't include Windows user paths, so we build it manually
  if (process.platform === 'win32') {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: platformProvider.buildExtendedPath(process.env.PATH),
      HOME: os.homedir(),
      USER: os.userInfo().username,
      USERPROFILE: os.homedir(),
    };
    return stringEntries(env);
  }

  // macOS/Linux: the interactive login shell (-ilc: bun and nvm write PATH to .zshrc / .bashrc),
  // or process.env while the shell is unavailable.
  return (await resolveLoginShellEnv()) ?? stringEntries(process.env);
}

/** `process.env` minus its unset keys. */
function stringEntries(env: NodeJS.ProcessEnv): ShellEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Build the environment for spawning git: the full `process.env` plus the user's shell
 * PATH (so a GUI-launched app finds git / git-lfs). Shared by worktree creation and
 * convergence so the two stay in lockstep.
 */
export async function getGitEnv(): Promise<ShellEnv> {
  const shellEnv = await getShellEnvironment();
  const result = stringEntries(process.env);

  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  if (shellEnv[pathKey]) {
    result[pathKey] = shellEnv[pathKey];
  }

  return result;
}

/**
 * Checks if git-lfs is available in the given environment.
 */
export async function checkGitLfsAvailable(env: Record<string, string>): Promise<boolean> {
  try {
    await execFileAsync('git', ['lfs', 'version'], {
      timeout: 5_000,
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command, retrying once with shell environment if it fails with ENOENT.
 * On macOS, GUI apps launched from Finder/Dock get minimal PATH that excludes
 * homebrew and other user-installed tools. Resolving the shell environment also
 * puts its PATH on process.env, so later calls succeed first time.
 */
export async function execWithShellEnv(
  cmd: string,
  args: string[],
  options?: Omit<ExecFileOptionsWithStringEncoding, 'encoding'>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(cmd, args, { ...options, encoding: 'utf8' });
  } catch (error) {
    // Only retry on ENOENT (command not found), only on macOS
    if (
      process.platform !== 'darwin' ||
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }

    const shellEnv = await resolveLoginShellEnv();
    if (!shellEnv) throw error;

    // Retry with fixed env (respect caller's other env vars, force the shell PATH)
    return await execFileAsync(cmd, args, {
      ...options,
      encoding: 'utf8',
      env: { ...shellEnv, ...options?.env, PATH: shellEnv.PATH },
    });
  }
}
