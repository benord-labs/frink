import { type ExecFileOptionsWithStringEncoding, execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  getDefaultShell as getPlatformDefaultShell,
  platform as platformProvider,
} from '../platform';

const execFileAsync = promisify(execFile);

// Cache the shell environment to avoid repeated shell spawns
let cachedEnv: Record<string, string> | null = null;
let cacheTime = 0;
let isFallbackCache = false;
const CACHE_TTL_MS = 60_000; // 1 minute cache
const FALLBACK_CACHE_TTL_MS = 10_000; // 10 second cache for fallback (retry sooner)

// Track PATH fix state for macOS GUI app PATH fix
let pathFixAttempted = false;
let pathFixSucceeded = false;

/**
 * Gets the full shell environment with proper PATH for all platforms.
 *
 * - **Windows**: Derives PATH from process.env + common install locations (no shell spawn)
 * - **macOS/Linux**: Spawns login shell to capture PATH from shell profiles
 *
 * This captures PATH and other environment variables needed to find user-installed tools
 * like git-lfs (homebrew on macOS) or Claude CLI (user-local on Windows).
 *
 * Results are cached for 1 minute to avoid repeated operations.
 */
async function getShellEnvironment(): Promise<Record<string, string>> {
  const now = Date.now();
  const ttl = isFallbackCache ? FALLBACK_CACHE_TTL_MS : CACHE_TTL_MS;
  if (cachedEnv && now - cacheTime < ttl) {
    // Return a copy to prevent caller mutations from corrupting cache
    return { ...cachedEnv };
  }

  // Windows: derive PATH without shell invocation
  // Git Bash PATH doesn't include Windows user paths, so we build it manually
  if (process.platform === 'win32') {
    const env: Record<string, string> = {
      ...process.env,
      PATH: platformProvider.buildExtendedPath(process.env.PATH),
      HOME: os.homedir(),
      USER: os.userInfo().username,
      USERPROFILE: os.homedir(),
    };

    // Ensure all values are strings
    const stringEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') {
        stringEnv[key] = value;
      }
    }

    cachedEnv = stringEnv;
    cacheTime = now;
    isFallbackCache = false;
    return { ...stringEnv };
  }

  // macOS/Linux: spawn login shell to get full environment
  const shell = getPlatformDefaultShell();

  try {
    // Use -lc flags (not -ilc):
    // -l: login shell (sources .zprofile/.profile for PATH setup)
    // -c: execute command
    // Avoids -i (interactive) to skip TTY prompts and reduce latency
    const { stdout } = await execFileAsync(shell, ['-lc', 'env'], {
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: os.homedir(),
      },
    });

    const env: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx);
        const value = line.substring(idx + 1);
        env[key] = value;
      }
    }

    cachedEnv = env;
    cacheTime = now;
    isFallbackCache = false;
    return { ...env };
  } catch (_error) {
    // Fall back to process.env if shell spawn fails
    // Cache with shorter TTL so we retry sooner
    const fallback: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        fallback[key] = value;
      }
    }
    cachedEnv = fallback;
    cacheTime = now;
    isFallbackCache = true;
    return { ...fallback };
  }
}

/**
 * Build the environment for spawning git: the full `process.env` plus the user's shell
 * PATH (so a GUI-launched app finds git / git-lfs). Shared by worktree creation and
 * convergence so the two stay in lockstep.
 */
export async function getGitEnv(): Promise<Record<string, string>> {
  const shellEnv = await getShellEnvironment();
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

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
 * homebrew and other user-installed tools. This lazily derives the user's
 * shell environment only when needed, then persists the fix to process.env.PATH.
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
    // Skip if we've already successfully fixed PATH, or if a fix attempt is in progress
    if (
      process.platform !== 'darwin' ||
      pathFixSucceeded ||
      pathFixAttempted ||
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }

    pathFixAttempted = true;

    try {
      const shellEnv = await getShellEnvironment();

      // Persist the fix to process.env so all subsequent calls benefit
      if (shellEnv.PATH) {
        process.env.PATH = shellEnv.PATH;
        pathFixSucceeded = true;
      }

      // Retry with fixed env (respect caller's other env vars, force PATH if present)
      const retryEnv = shellEnv.PATH
        ? { ...shellEnv, ...options?.env, PATH: shellEnv.PATH }
        : { ...shellEnv, ...options?.env };

      return await execFileAsync(cmd, args, {
        ...options,
        encoding: 'utf8',
        env: retryEnv,
      });
    } catch (retryError) {
      // Shell env derivation or retry failed - allow future retries
      pathFixAttempted = false;
      throw retryError;
    }
  }
}
