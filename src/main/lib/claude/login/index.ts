// Adapted from an MIT-licensed project; its notice is in THIRD_PARTY_LICENSES.md.
import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from 'node:child_process';
import { app } from 'electron';
import { killProcessTree } from '../../agent-runner/process-settlement';
import type { SignInOutcome } from '../../agent-runner/sign-in-outcome';
import { buildClaudeEnv, getBundledClaudeBinaryPath } from '../env';

const LOGIN_TIMEOUT_MS = 180_000;

type QuitListener = (event: 'will-quit', stop: () => void) => void;

type ClaudeLoginDeps = {
  binaryPath: () => string;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  baseEnv: () => Record<string, string>;
  /** Frink's app, which says when it quits. */
  app: { on: QuitListener; off: QuitListener };
};

const DEFAULT_DEPS: ClaudeLoginDeps = {
  binaryPath: getBundledClaudeBinaryPath,
  baseEnv: buildClaudeEnv,
  app,
};

type Login = { done: Promise<SignInOutcome>; stop: () => void };
let running: Login | undefined;

/** Runs Claude's own browser sign-in, one at a time, and says how it ended. */
export function signInToClaude(deps: ClaudeLoginDeps = DEFAULT_DEPS): Promise<SignInOutcome> {
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
  // The login lands in the one store Frink's agents read; no exported key, token or SDK session mark steers it.
  const {
    CLAUDE_CONFIG_DIR: _scoped,
    ANTHROPIC_API_KEY: _key,
    CLAUDE_CODE_OAUTH_TOKEN: _token,
    CLAUDE_CODE_ENTRYPOINT: _entrypoint,
    CLAUDE_CODE_ENABLE_TASKS: _tasks,
    ...env
  } = deps.baseEnv();
  const child = (deps.spawn ?? spawn)(deps.binaryPath(), ['auth', 'login', '--claudeai'], {
    env: { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
    // stdin stays open and unwritten: Claude can end its browser callback when stdin closes.
    stdio: 'pipe',
    detached: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  let stopped = false;
  const stop = () => {
    stopped = true;
    killProcessTree(child);
  };
  const done = new Promise<SignInOutcome>((resolve) => {
    const timer = setTimeout(stop, LOGIN_TIMEOUT_MS);
    deps.app.on('will-quit', stop);
    const finish = (outcome: SignInOutcome) => {
      clearTimeout(timer);
      deps.app.off('will-quit', stop);
      child.stdin.destroy();
      resolve(outcome);
    };
    // With no pid Claude never started; otherwise the error is a stop that could not be delivered.
    child.once('error', () => finish(child.pid === undefined ? 'unavailable' : 'stopped'));
    // A signal Frink did not send, such as macOS refusing an unsigned binary, is a damaged install.
    child.once('exit', (code) =>
      finish(code === 0 ? 'finished' : code === null && !stopped ? 'unavailable' : 'stopped'),
    );
  });
  return { done, stop };
}
