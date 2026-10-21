import { app, shell } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { CodexAppServerClient, withTimeout } from '../app-server-client';
import { resolveCodexBinary } from '../codex-binary';

// The chatgpt login's wire shapes in codex-rs app-server-protocol v2/account.rs.
const LOGIN_STARTED = z.object({ loginId: z.string(), authUrl: z.string() });
const LOGIN_COMPLETED = z.object({ success: z.boolean() });

const CANCEL_TIMEOUT_MS = 2_000;

type QuitListener = (event: 'before-quit', stop: () => void) => void;

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

type Login = { done: Promise<boolean>; stop: () => void; id?: string; page?: string };
let running: Login | undefined;

/** Runs Codex's own ChatGPT sign-in in the browser, one at a time; true when it finished. */
export function signInToCodex(deps: CodexLoginDeps = DEFAULT_DEPS): Promise<boolean> {
  if (running) {
    if (running.page) void deps.openExternal(running.page).catch((error) => log.warn(error));
    return running.done;
  }
  const binary = deps.binary();
  if (!binary) return Promise.resolve(false);
  const current = startLogin(binary, deps);
  running = current;
  void current.done.then(() => {
    if (running === current) running = undefined;
  });
  return current.done;
}

/** Stops the sign-in that is waiting, if any, so the next start opens a fresh one. */
export function cancelCodexSignIn(): void {
  running?.stop();
  running = undefined;
}

function startLogin(binary: string, deps: CodexLoginDeps): Login {
  // Codex writes the login to its own home, which Frink never sets, so detection reads it there.
  const client = new CodexAppServerClient({
    binary,
    clientInfo: { name: 'frink-login', version: '1' },
  });
  let finished = false;
  let resolve: (signedIn: boolean) => void = () => undefined;
  const dispose = () => void client.disposeAndWait().catch((error) => log.warn(error));
  // Codex is ended once it has answered the cancel, or straight away when there is none to send.
  const end = (signedIn: boolean, cancelled?: Promise<unknown>) => {
    if (finished) return;
    finished = true;
    deps.app.off('before-quit', quit);
    resolve(signedIn);
    if (cancelled) void Promise.allSettled([cancelled]).then(dispose);
    else dispose();
  };
  // Frink does not wait on quit, so Codex and its sign-in page server end at once.
  const quit = () => end(false);
  const stop = () => {
    const loginId = finished ? undefined : login.id;
    const cancel = loginId && client.sendRequest('account/login/cancel', { loginId });
    end(false, cancel ? withTimeout(cancel, CANCEL_TIMEOUT_MS, 'Codex did not cancel') : undefined);
  };
  const login: Login = {
    done: new Promise((settle) => {
      resolve = settle;
    }),
    stop,
  };
  deps.app.on('before-quit', quit);
  openLogin(client, login, deps, end).catch((error) => {
    log.warn('[Codex sign-in] did not start', error instanceof Error ? error.message : error);
    end(false);
  });
  return login;
}

/** Starts the browser step and ends the login when Codex reports it, or when Codex stops. */
async function openLogin(
  client: CodexAppServerClient,
  login: Login,
  deps: CodexLoginDeps,
  end: (signedIn: boolean) => void,
): Promise<void> {
  await client.start();
  client.onClose(() => end(false));
  // Account notifications carry no thread id, so they route to the subscription for none.
  client.forThread('').onNotification('account/login/completed', (params) => {
    end(LOGIN_COMPLETED.safeParse(params).data?.success === true);
  });
  const started = LOGIN_STARTED.parse(
    await client.sendRequest('account/login/start', { type: 'chatgpt' }),
  );
  login.id = started.loginId;
  // Only secure web pages are opened.
  if (!started.authUrl.startsWith('https://')) return end(false);
  login.page = started.authUrl;
  await deps.openExternal(started.authUrl);
}
