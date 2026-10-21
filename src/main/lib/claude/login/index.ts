// Adapted from an MIT-licensed project; its notice is in THIRD_PARTY_LICENSES.md.
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { killProcessTree } from '../../agent-runner/process-settlement';
import { getBundledClaudeBinaryPath, getClaudeShellEnvironment } from '../env';

const LOGIN_TIMEOUT_MS = 180_000;

type QuitListener = (event: 'before-quit', stop: () => void) => void;

type ClaudeLoginDeps = {
  binaryPath: () => string;
  shellEnv: () => Record<string, string>;
  /** Frink's app, which says when it quits. */
  app: { on: QuitListener; off: QuitListener };
};

const DEFAULT_DEPS: ClaudeLoginDeps = {
  binaryPath: getBundledClaudeBinaryPath,
  shellEnv: getClaudeShellEnvironment,
  app,
};

type Login = { done: Promise<boolean>; stop: () => void };
let running: Login | undefined;

/** Runs Claude's own browser sign-in, one at a time; true when it finished. */
export function signInToClaude(deps: ClaudeLoginDeps = DEFAULT_DEPS): Promise<boolean> {
  if (running) return running.done;
  const login = startLogin(deps);
  const current: Login = {
    stop: login.stop,
    done: login.done.finally(() => {
      if (running === current) running = undefined;
    }),
  };
  running = current;
  return current.done;
}

/** Stops the sign-in that is waiting, if any, so the next start opens a fresh one. */
export function cancelClaudeSignIn(): void {
  running?.stop();
  running = undefined;
}

function startLogin(deps: ClaudeLoginDeps): Login {
  // The login lands in the one store Frink's agents read, and no exported key or token steers it.
  const {
    CLAUDE_CONFIG_DIR: _scoped,
    ANTHROPIC_API_KEY: _key,
    CLAUDE_CODE_OAUTH_TOKEN: _token,
    ...env
  } = deps.shellEnv();
  const child = spawn(deps.binaryPath(), ['auth', 'login', '--claudeai'], {
    env: { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
    // stdin stays open and unwritten: Claude can end its browser callback when stdin closes.
    stdio: 'pipe',
    detached: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  const stop = () => killProcessTree(child);
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(stop, LOGIN_TIMEOUT_MS);
    deps.app.on('before-quit', stop);
    const finish = (finished: boolean) => {
      clearTimeout(timer);
      deps.app.off('before-quit', stop);
      child.stdin.destroy();
      resolve(finished);
    };
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
  return { done, stop };
}
