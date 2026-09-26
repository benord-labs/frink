import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { getBundledBinaryPath } from '../agent-runner/bundled-binary';
import { buildEnvironment, getDefaultShell, isWindows } from '../platform';

// Cache the shell environment
let cachedShellEnv: Record<string, string> | null = null;

// Delimiter for parsing env output
const DELIMITER = '_CLAUDE_ENV_DELIMITER_';

// Keys to strip (prevent interference from unrelated providers).
// ANTHROPIC_BASE_URL is kept on purpose, so an existing API-proxy setup keeps working.
// ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN are NOT stripped here but every Claude spawn path
// strips them itself before injecting the account it resolved — the executor inline, the one-shot
// sites via buildOneShotClaudeEnv. Leaving them in the base env would let an exported shell token
// silently outrank the selected account. Based on PR #29 by @sa4hnd.
const STRIPPED_ENV_KEYS = ['OPENAI_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];

// Cache the bundled binary path (only compute once)
let cachedBinaryPath: string | null = null;
let binaryPathComputed: boolean = false;

/**
 * Get path to the bundled Claude binary.
 * Returns the path to the native Claude executable bundled with the app.
 * CACHED - only computes path once and logs verbose info on first call.
 */
export function getBundledClaudeBinaryPath(): string {
  // Return cached path if already computed
  if (binaryPathComputed && cachedBinaryPath) {
    return cachedBinaryPath;
  }

  cachedBinaryPath = getBundledBinaryPath('claude');
  binaryPathComputed = true;

  if (process.env.DEBUG_CLAUDE_BINARY) {
    // biome-ignore lint/suspicious/noConsole: backend
    console.log('[claude-binary] binaryPath:', cachedBinaryPath);
  }

  return cachedBinaryPath;
}

/**
 * Parse environment variables from shell output
 */
function parseEnvOutput(output: string): Record<string, string> {
  const envSection = output.split(DELIMITER)[1];
  if (!envSection) return {};

  const env: Record<string, string> = {};
  for (const line of stripVTControlCharacters(envSection).split('\n').filter(Boolean)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex > 0) {
      const key = line.substring(0, separatorIndex);
      const value = line.substring(separatorIndex + 1);
      env[key] = value;
    }
  }
  return env;
}

/**
 * Strip sensitive keys from environment
 */
function stripSensitiveKeys(env: Record<string, string>): void {
  for (const key of STRIPPED_ENV_KEYS) {
    if (key in env) {
      // biome-ignore lint/suspicious/noConsole: backend
      console.log(`[claude-env] Stripped ${key} from shell environment`);
      delete env[key];
    }
  }
}

/**
 * Load full shell environment using interactive login shell.
 * This captures PATH, HOME, and all shell profile configurations.
 * Results are cached for the lifetime of the process.
 */
export function getClaudeShellEnvironment(): Record<string, string> {
  if (cachedShellEnv !== null) {
    return { ...cachedShellEnv };
  }

  // Windows: avoid shell spawning and derive from platform provider.
  if (isWindows()) {
    const env = buildEnvironment();
    stripSensitiveKeys(env);
    cachedShellEnv = env;
    return { ...env };
  }

  const shell = getDefaultShell();
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"; exit`;

  try {
    const output = execFileSync(shell, ['-ilc', command], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        // Prevent Oh My Zsh from blocking with auto-update prompts
        DISABLE_AUTO_UPDATE: 'true',
        // Minimal env to bootstrap the shell
        HOME: os.homedir(),
        USER: os.userInfo().username,
        SHELL: shell,
      },
    });

    const env = parseEnvOutput(output);

    // Strip keys that could interfere with Claude's auth resolution
    stripSensitiveKeys(env);

    // biome-ignore lint/suspicious/noConsole: backend
    console.log(`[claude-env] Loaded ${Object.keys(env).length} environment variables from shell`);
    cachedShellEnv = env;
    return { ...env };
  } catch {
    // biome-ignore lint/suspicious/noConsole: backend
    console.error('[claude-env] Failed to load shell environment');
    const fallback = buildEnvironment();
    stripSensitiveKeys(fallback);
    cachedShellEnv = fallback;
    return { ...fallback };
  }
}

/**
 * Build the complete environment for Claude SDK.
 * Merges shell environment, process.env, and custom overrides.
 */
export function buildClaudeEnv(options?: {
  ghToken?: string;
  customEnv?: Record<string, string>;
  enableTasks?: boolean;
}): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. Start with shell environment (has HOME, full PATH, etc.)
  try {
    const shellEnv = getClaudeShellEnvironment();
    for (const [key, value] of Object.entries(shellEnv)) {
      env[key] = value;
    }
  } catch {
    // biome-ignore lint/suspicious/noConsole: backend
    console.error('[claude-env] Shell env failed, using process.env');
  }

  // 2. Overlay current process.env (preserves Electron-set vars)
  // BUT: Don't overwrite PATH from shell env - Electron's PATH is minimal when launched from Finder
  const shellPath = env.PATH;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // The SDK writes these into process.env (on import, on first query()) and the child sets them
  // itself; inheriting them would key a spawn built before that differently from every one after.
  delete env.CLAUDE_AGENT_SDK_VERSION;
  delete env.NoDefaultCurrentDirectoryInExePath;
  // Restore shell PATH if we had one (it contains nvm, homebrew, etc.)
  if (shellPath) {
    env.PATH = shellPath;
  }

  // 3. Ensure critical vars are present
  const platformEnv = buildEnvironment();
  if (!env.HOME) env.HOME = platformEnv.HOME;
  if (!env.USER) env.USER = platformEnv.USER;
  if (!env.SHELL) env.SHELL = getDefaultShell();
  if (!env.TERM) env.TERM = 'xterm-256color';
  if (isWindows() && !env.USERPROFILE) env.USERPROFILE = os.homedir();

  // 4. Add custom overrides
  if (options?.ghToken) {
    env.GH_TOKEN = options.ghToken;
  }
  if (options?.customEnv) {
    for (const [key, value] of Object.entries(options.customEnv)) {
      if (value === '') {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }

  // 5. Mark as SDK entry
  env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  // Enable/disable task management tools (default enabled)
  env.CLAUDE_CODE_ENABLE_TASKS = options?.enableTasks !== false ? 'true' : 'false';

  return env;
}

/**
 * Environment for a ONE-SHOT Claude SDK call — repo description and chat naming, the two spawn
 * sites that bypass the executor. Guarantees two things a bare {@link buildClaudeEnv} cannot:
 *
 * 1. Inherited shell/process `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are STRIPPED, so an
 *    exported token cannot override the credential the caller selected. A passthrough account
 *    carries no token of its own, which is exactly when a stray shell token would win.
 * 2. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is pinned so the CLI reads the canonical keychain login
 *    and refreshes it itself. See docs/decisions/claude-credential-ownership-at-spawn.md.
 */
export function buildOneShotClaudeEnv(credential: {
  token: string | null;
  isApiKey: boolean;
}): Record<string, string> {
  const {
    ANTHROPIC_API_KEY: _shellApiKey,
    CLAUDE_CODE_OAUTH_TOKEN: _shellOauth,
    ...baseEnv
  } = buildClaudeEnv({ enableTasks: false });
  return {
    ...baseEnv,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    ...(credential.token
      ? credential.isApiKey
        ? { ANTHROPIC_API_KEY: credential.token }
        : { CLAUDE_CODE_OAUTH_TOKEN: credential.token }
      : {}),
  };
}

/**
 * Clear cached shell environment (useful for testing)
 */
export function clearClaudeEnvCache(): void {
  cachedShellEnv = null;
}
