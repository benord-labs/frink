import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import log from 'electron-log';
import { platform } from './index';
import { warmNvmBinDirs } from './nvm';

/**
 * The user's login-shell environment, resolved once in the background and shared by every spawn
 * path. A failed attempt is never kept: callers get the platform fallback until one succeeds.
 */

/** Environment variables as a shell prints them: every value a string. */
export type ShellEnv = Record<string, string>;

/** Why the login shell gave no environment. */
export type ShellFailure = {
  message: string;
  code: string | number | null;
  signal: string | null;
  stderr: string;
  /** Ended by our own timeout, as opposed to exiting or being killed by something else. */
  timedOut: boolean;
};

export type ShellOutcome = { ok: true; env: ShellEnv } | { ok: false; failure: ShellFailure };

export type LoginShellEnvDeps = {
  spawnShell: () => Promise<ShellOutcome>;
  extendPath: (currentPath: string | undefined) => string;
};

// Generous: an nvm / oh-my-zsh profile can take several seconds to load on a cold start.
const RESOLVE_TIMEOUT_MS = 15_000;
// After a failure, on-demand callers get the fallback at once rather than wait out a timeout.
const FAILURE_COOLDOWN_MS = 60_000;
const STARTUP_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
// A caller about to start a long-lived process (session, app server) forces a fresh attempt rather
// than inherit a fallback PATH it would keep — until the shell has failed this many times running.
const MAX_FORCED_ATTEMPTS = STARTUP_RETRY_DELAYS_MS.length + 1;
const STDERR_TAIL_CHARS = 500;

/** `env -0` output between two copies of `delimiter`; NUL-separated, so values may hold newlines. */
function parseEnvOutput(output: string, delimiter: string): ShellEnv {
  const envSection = output.split(delimiter)[1] ?? '';
  const entries = envSection
    .split('\0')
    .map((line) => [line.substring(0, line.indexOf('=')), line.substring(line.indexOf('=') + 1)])
    .filter(([key]) => key.length > 0);
  return Object.fromEntries(entries);
}

/** The shell every install of the platform has, whatever $SHELL says. */
export function stockShell(platformId: NodeJS.Platform): string {
  return platformId === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/** Shells to ask, in order: $SHELL, the account's login shell, then the platform's stock shell. */
export function loginShellCandidates(
  envShell: string | undefined,
  accountLoginShell: string | null | undefined,
  platformId: NodeJS.Platform,
): string[] {
  const named = [envShell, accountLoginShell, stockShell(platformId)].map((s) => s?.trim() ?? '');
  return [...new Set(named.filter(Boolean))];
}

/** The first candidate that prints an environment; otherwise the last failure. */
export async function readLoginShellEnv(
  shells: string[],
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<ShellOutcome> {
  let outcome: ShellOutcome = {
    ok: false,
    failure: {
      message: 'no login shell to ask',
      code: null,
      signal: null,
      stderr: '',
      timedOut: false,
    },
  };
  for (const shell of shells) {
    outcome = await spawnLoginShell(shell, timeoutMs);
    // A timeout is the profile being slow; the next shell would wait on it all over again.
    if (outcome.ok || outcome.failure.timedOut) return outcome;
    log.warn(`[shell-env] ${shell} gave no environment`, outcome.failure);
  }
  return outcome;
}

function accountShell(): string | null {
  try {
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

function spawnLoginShell(shell: string, timeoutMs: number): Promise<ShellOutcome> {
  // Random per spawn, so no environment value can contain it.
  const delimiter = `_FRINK_ENV_${randomUUID().replaceAll('-', '')}_`;
  const command = `printf '%s' '${delimiter}'; env -0; printf '%s' '${delimiter}'; exit`;

  return new Promise((resolve) => {
    // -i as well as -l: installers (bun, nvm) add their PATH lines to .zshrc / .bashrc.
    const child = execFile(
      shell,
      ['-ilc', command],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        // An interactive zsh ignores SIGTERM, so the timeout has to kill outright.
        killSignal: 'SIGKILL',
        env: {
          // Minimal env to bootstrap the shell
          HOME: os.homedir(),
          USER: os.userInfo().username,
          SHELL: shell,
          TERM: 'dumb',
          // Prevent Oh My Zsh from blocking with auto-update prompts
          DISABLE_AUTO_UPDATE: 'true',
        },
      },
      (error, stdout, stderr) => {
        const env = error ? {} : parseEnvOutput(stdout, delimiter);
        if (env.PATH) {
          resolve({ ok: true, env });
          return;
        }
        resolve({
          ok: false,
          failure: {
            message: error?.message ?? 'login shell printed no PATH',
            code: error?.code ?? null,
            signal: error?.signal ?? null,
            // Node sets `killed` only when it ended the child itself, which here is the timeout.
            timedOut: error?.killed === true,
            stderr: stderr.slice(-STDERR_TAIL_CHARS),
          },
        });
      },
    );
    // Nothing will ever answer a prompt; EOF on stdin makes one fail instead of hang.
    child.stdin?.end();
  });
}

/** The shell's PATH first, then entries only the launch env had (direnv, a venv, `bun run dev`). */
function mergePath(shellPath: string, currentPath: string | undefined): string {
  const entries = [...shellPath.split(':'), ...(currentPath ?? '').split(':')].filter(Boolean);
  return [...new Set(entries)].join(':');
}

export class LoginShellEnvResolver {
  private resolvedEnv: ShellEnv | null = null;
  private inFlight: Promise<ShellEnv | null> | null = null;
  private lastFailureAt = 0;
  private consecutiveFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: LoginShellEnvDeps = {
      spawnShell: () =>
        readLoginShellEnv(
          loginShellCandidates(process.env.SHELL, accountShell(), process.platform),
        ),
      extendPath: (currentPath) => platform.buildExtendedPath(currentPath),
    },
  ) {}

  /**
   * Spawns the shell at most once at a time; null on Windows, on failure, and in the cooldown after
   * one unless `force`. A success puts only the shell's PATH and SSH agent socket on `process.env`.
   */
  resolve(options?: { force?: boolean }): Promise<ShellEnv | null> {
    if (process.platform === 'win32') return Promise.resolve(null);
    if (this.resolvedEnv) return Promise.resolve({ ...this.resolvedEnv });
    if (this.inFlight) return this.inFlight;
    const coolingDown = this.lastFailureAt && Date.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS;
    if (!options?.force && coolingDown) return Promise.resolve(null);

    this.inFlight = this.deps
      .spawnShell()
      .then((outcome) => {
        if (!outcome.ok) {
          this.lastFailureAt = Date.now();
          this.consecutiveFailures += 1;
          log.warn('[shell-env] Failed to load login-shell environment', outcome.failure);
          return null;
        }
        // Readers (Claude, git) take PATH from here, so it must carry the launch-only entries too.
        const env = { ...outcome.env, PATH: mergePath(outcome.env.PATH, process.env.PATH) };
        this.resolvedEnv = env;
        this.lastFailureAt = 0;
        this.consecutiveFailures = 0;
        process.env.PATH = env.PATH;
        // The shell runs on a bare env, so an agent socket here is one the profile chose (1Password,
        // gpg-agent): git and ssh spawned from the app must use it, as they do in a terminal.
        const agentSocket = outcome.env.SSH_AUTH_SOCK;
        if (agentSocket) process.env.SSH_AUTH_SOCK = agentSocket;
        log.info(`[shell-env] Loaded ${Object.keys(env).length} variables from shell`);
        return { ...env };
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Before starting a process that keeps its env: wait for a fresh attempt, not the cooldown. */
  async ensure(): Promise<ShellEnv | null> {
    const joinedAttempt = this.inFlight !== null;
    const env = await this.resolve({ force: this.consecutiveFailures < MAX_FORCED_ATTEMPTS });
    // Joined an attempt that then failed (e.g. the startup one): make one fresh attempt of our own.
    if (env || !joinedAttempt || this.consecutiveFailures >= MAX_FORCED_ATTEMPTS) return env;
    return this.resolve({ force: true });
  }

  /** The last resolved environment, or null. Never spawns, never blocks. */
  current(): ShellEnv | null {
    return this.resolvedEnv ? { ...this.resolvedEnv } : null;
  }

  /** At startup: extend PATH at once, then resolve in the background, retrying on failure. */
  start(): void {
    if (process.platform === 'win32') return;
    process.env.PATH = this.deps.extendPath(process.env.PATH);
    this.resolveOrRetry(0);
  }

  reset(): void {
    this.resolvedEnv = null;
    this.inFlight = null;
    this.lastFailureAt = 0;
    this.consecutiveFailures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resolveOrRetry(attempt: number): void {
    void this.resolve({ force: true }).then((env) => {
      const delay = STARTUP_RETRY_DELAYS_MS[attempt];
      if (env || delay === undefined) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.resolveOrRetry(attempt + 1);
      }, delay);
      this.retryTimer.unref?.();
    });
  }
}

let activeResolver = new LoginShellEnvResolver();

/** Swap the process-wide resolver (tests inject a fake shell through this). */
export function setLoginShellEnvResolver(resolver: LoginShellEnvResolver): void {
  activeResolver.reset();
  activeResolver = resolver;
}

export function resolveLoginShellEnv(options?: { force?: boolean }): Promise<ShellEnv | null> {
  return activeResolver.resolve(options);
}

export function getLoginShellEnvSync(): ShellEnv | null {
  return activeResolver.current();
}

/** Wait for the login-shell environment before spawning something that keeps its env. */
export async function ensureLoginShellEnv(): Promise<void> {
  await activeResolver.ensure();
}

export function startLoginShellEnvResolve(): void {
  // The fallback PATH's nvm entry is read here, once and asynchronously, never on a request path.
  void warmNvmBinDirs(os.homedir());
  activeResolver.start();
}

export function resetLoginShellEnvForTests(): void {
  activeResolver.reset();
}
