import { app, shell } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { withTimeout } from '../../../platform/with-timeout';
import type { SignInOutcome } from '../../sign-in-outcome';
import { CodexAppServerClient } from '../app-server-client';
import { resolveCodexBinary } from '../codex-binary';

// The chatgpt login's wire shapes in codex-rs app-server-protocol v2/account.rs.
const LOGIN_STARTED = z.object({ loginId: z.string(), authUrl: z.string() });
const LOGIN_COMPLETED = z.object({ success: z.boolean() });

const CANCEL_TIMEOUT_MS = 2_000;

type QuitListener = (event: 'will-quit', stop: () => void) => void;

type CodexLoginDeps = {
  binary: () => string | null;
  openExternal: (url: string) => Promise<void>;
  /** Frink's app, which says when it quits. */
  app: { on: QuitListener; off: QuitListener };
};

const DEFAULT_DEPS: CodexLoginDeps = {
  binary: resolveCodexBinary,
  openExternal: (url) => shell.openExternal(url),
  app,
};

type Login = { done: Promise<SignInOutcome>; stop: () => void; id?: string; page?: string };
let running: Login | undefined;

/** Runs Codex's own ChatGPT sign-in in the browser, one at a time, and says how it ended. */
export function signInToCodex(deps: CodexLoginDeps = DEFAULT_DEPS): Promise<SignInOutcome> {
  if (running) {
    if (running.page) void deps.openExternal(running.page).catch((error) => log.warn(error));
    return running.done;
  }
  const binary = deps.binary();
  if (!binary) return Promise.resolve('unavailable');
  running = startLogin(binary, deps);
  return running.done;
}

/** Stops the waiting sign-in, if any; a stopped login frees its slot, so the next start is fresh. */
export function cancelCodexSignIn(): void {
  running?.stop();
}

function startLogin(binary: string, deps: CodexLoginDeps): Login {
  // Codex writes the login to its own home, which Frink never sets, so detection reads it there.
  const client = new CodexAppServerClient({
    binary,
    clientInfo: { name: 'frink-login', version: '1' },
  });
  let finished = false;
  let resolve: (outcome: SignInOutcome) => void = () => undefined;
  const dispose = () => void client.disposeAndWait().catch((error) => log.warn(error));
  // Codex is ended once it has answered the cancel, or straight away when there is none to send.
  const end = (outcome: SignInOutcome, cancelled?: Promise<unknown>) => {
    if (finished) return;
    finished = true;
    if (running === login) running = undefined;
    deps.app.off('will-quit', quit);
    resolve(outcome);
    if (cancelled) void Promise.allSettled([cancelled]).then(dispose);
    else dispose();
  };
  // Frink does not wait on quit, so Codex and its sign-in page server end at once.
  const quit = () => end('stopped');
  const stop = () => {
    const loginId = finished ? undefined : login.id;
    const cancel = loginId && client.sendRequest('account/login/cancel', { loginId });
    end(
      'stopped',
      cancel ? withTimeout(cancel, CANCEL_TIMEOUT_MS, 'Codex did not cancel') : undefined,
    );
  };
  const login: Login = {
    done: new Promise((settle) => {
      resolve = settle;
    }),
    stop,
  };
  deps.app.on('will-quit', quit);
  openLogin(client, login, deps, end).catch((error) => {
    log.warn('[Codex sign-in] failed', error instanceof Error ? error.message : error);
    end('failed');
  });
  return login;
}

/** Starts the browser step and ends the login when Codex reports it, or when Codex stops. */
async function openLogin(
  client: CodexAppServerClient,
  login: Login,
  deps: CodexLoginDeps,
  end: (outcome: SignInOutcome) => void,
): Promise<void> {
  try {
    await client.start();
  } catch (error) {
    log.warn('[Codex sign-in] Codex did not start', error instanceof Error ? error.message : error);
    return end('unavailable');
  }
  // Codex ending before the sign-in did is a crash, never the person stopping it.
  client.onClose(() => end('failed'));
  // Account notifications carry no thread id, so they route to the subscription for none.
  client.forThread('').onNotification('account/login/completed', (params) => {
    end(LOGIN_COMPLETED.safeParse(params).data?.success === true ? 'finished' : 'stopped');
  });
  const started = LOGIN_STARTED.parse(
    await client.sendRequest('account/login/start', { type: 'chatgpt' }),
  );
  login.id = started.loginId;
  // Only secure web pages are opened.
  if (!started.authUrl.startsWith('https://')) return end('failed');
  login.page = started.authUrl;
  await deps.openExternal(started.authUrl);
}
