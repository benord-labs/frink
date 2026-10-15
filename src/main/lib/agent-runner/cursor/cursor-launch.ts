import { access, constants, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { resolveElectronResourcePath } from '../../platform/electron-resource-path';
import { userEnv } from '../acp/agents/launch';
import { cursorHostEnv } from './cursor-home';
import { saveCursorModels } from './cursor-models';
import {
  type CursorHostMessage,
  type CursorHostRequest,
  type CursorRunnerParams,
  type ForkHost,
  forkUtilityHost,
  PLAN_REQUIRED,
  SIGNED_OUT,
} from './cursor-runner';
import { CURSOR_TOOL_NAMES } from './cursor-tools';

type Env = Record<string, string>;
type AppPaths = { isPackaged: boolean; getAppPath(): string; getPath(name: 'userData'): string };
export type CursorLaunchDeps = {
  env?: Env;
  app?: AppPaths;
  sdkRoot?: string;
  forkHost?: ForkHost;
  openExternal?: (url: string) => Promise<void>;
};
type SdkCheck = { ok: true; entry: string; ripgrep: string } | { ok: false; reason: string };
export type CursorAgentCheck =
  | { status: 'ready' }
  | { status: 'missing' | 'signed-out' | 'plan-required' | 'failed'; reason: string };

/** The one Cursor setup Frink has tested: its SDK version, hook protocol and offered tools. */
const CURSOR_ROW = {
  sdk: { version: '1.0.37' },
  hookVersions: ['1.0.0'],
  tools: CURSOR_TOOL_NAMES,
};
const HOST = {
  development: ['resources', 'cursor', 'cursor-host.mjs'],
  packaged: ['cursor', 'cursor-host.mjs'],
};
// Each chat's folders are named by its key, so a key must not name another folder.
const CHAT_KEY = /^[A-Za-z0-9_-]+$/;
const CHECK_MS = 30_000;
// Cursor's own sign-in waits about this long for the browser before it gives up.
const SIGN_IN_MS = 20 * 60_000;
const NO_SDK = "Frink can't find Cursor's SDK on this computer.";
const NO_RIPGREP =
  'Part of Cursor is missing from this copy of Frink. Reinstall Frink, then try again.';
const BAD_CHAT = "Frink can't start Cursor for this chat.";
const CHECKED_NOT: CursorAgentCheck = {
  status: 'failed',
  reason: "Frink couldn't reach Cursor. Try again in a moment.",
};
const packageSchema = z.object({ name: z.literal('@cursor/sdk'), version: z.string() });
type SdkDeps = Pick<CursorLaunchDeps, 'sdkRoot' | 'app'>;

// Frink's own packages, which a built app keeps in its archive, where Electron reads them.
const installedSdkRoot = (paths: Pick<AppPaths, 'getAppPath'>) =>
  path.join(paths.getAppPath(), 'node_modules', '@cursor', 'sdk');

const readVersion = (root: string) =>
  readFile(path.join(root, 'package.json'), 'utf8')
    .then((text) => packageSchema.parse(JSON.parse(text)).version)
    .catch(() => undefined);

const runnable = (file: string) =>
  access(file, constants.X_OK).then(
    () => true,
    () => false,
  );

/** Cursor's ripgrep, in the platform package the SDK itself finds: the nearest one above it. */
async function findRipgrep(sdkRoot: string): Promise<string | undefined> {
  const platform = `sdk-${process.platform}-${process.arch}`;
  for (let dir = path.dirname(sdkRoot); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const rg = path.join(dir, 'node_modules', '@cursor', platform, 'bin', 'rg');
    if (await runnable(rg)) return rg;
  }
  return undefined;
}

/** The SDK's module entry when the copy found is the tested version, or why it can't be used. */
async function checkedSdk(deps: SdkDeps): Promise<SdkCheck> {
  const root = deps.sdkRoot ?? installedSdkRoot(deps.app ?? app);
  const version = await readVersion(root);
  if (!version) return { ok: false, reason: NO_SDK };
  if (version !== CURSOR_ROW.sdk.version) {
    return {
      ok: false,
      reason: `Frink checked Cursor's SDK ${CURSOR_ROW.sdk.version}. This copy is ${version}.`,
    };
  }
  const ripgrep = await findRipgrep(root);
  if (!ripgrep) return { ok: false, reason: NO_RIPGREP };
  return { ok: true, entry: path.join(root, 'dist', 'esm', 'index.js'), ripgrep };
}

/** Prepares one turn's launch, checked before every turn so a changed install is caught. */
export async function resolveCursorLaunch(
  input: { chatKey: string },
  deps: CursorLaunchDeps = {},
): Promise<{ ok: true; launch: CursorRunnerParams['launch'] } | { ok: false; reason: string }> {
  if (!CHAT_KEY.test(input.chatKey)) return { ok: false, reason: BAD_CHAT };
  const sdk = await checkedSdk(deps);
  if (!sdk.ok) return sdk;
  const paths = deps.app ?? app;
  const env = deps.env ?? (await userEnv());
  const chat = path.join(paths.getPath('userData'), 'cursor', 'chats', input.chatKey);
  const home = path.join(chat, 'home');
  return {
    ok: true,
    launch: {
      sdkEntry: sdk.entry,
      hostPath: resolveElectronResourcePath(paths, HOST),
      // Cursor searches with the same ripgrep Frink's gate asks.
      env: { ...cursorHostEnv(env, home), CURSOR_RIPGREP_PATH: sdk.ripgrep },
      home,
      storeDir: path.join(chat, 'store'),
      realHome: env.HOME || os.homedir(),
      ripgrep: sdk.ripgrep,
      tools: CURSOR_ROW.tools,
      hookVersions: CURSOR_ROW.hookVersions,
    },
  };
}

type HostInput = Parameters<ForkHost>[0];
type HostTalk<T> = {
  send(request: CursorHostRequest): void;
  settle(value: T): void;
  fail(text: string): void;
};

/** Starts a host and settles on what `onMessage` decides, or on `failure` if the host gives up. */
function talkToHost<T>(
  forkHost: ForkHost,
  input: HostInput,
  give: { failure: T; ms: number; what: string },
  onMessage: (message: CursorHostMessage, talk: HostTalk<T>) => void,
): Promise<T> {
  return new Promise((resolve) => {
    let host: ReturnType<ForkHost> | undefined;
    let settled = false;
    const settle = (value: T) => {
      settled = true;
      clearTimeout(timer);
      host?.kill();
      resolve(value);
    };
    const fail = (text: string) => {
      // Settling kills the host, so its exit then is expected.
      if (settled) return;
      log.warn(`[Cursor] ${give.what}: ${text}`);
      settle(give.failure);
    };
    const timer = setTimeout(() => fail('no answer'), give.ms);
    const talk: HostTalk<T> = { send: (request) => host?.send(request), settle, fail };
    try {
      host = forkHost(input, {
        message: (message) => onMessage(message, talk),
        exit: () => fail('the host stopped'),
      });
    } catch (error) {
      fail(String(error));
    }
  });
}

/** Cursor reports no sign-in, or turned down the key it has stored. */
const turnedDown = (message: CursorHostMessage) =>
  message.type === 'auth'
    ? message.status !== 'logged-in'
    : message.type === 'error' && message.code === 'unauthenticated';

/** A host under the user's real home, where Cursor keeps its own sign-in; it opens no agent. */
async function realHomeHost(
  deps: CursorLaunchDeps,
): Promise<{ ok: true; input: HostInput } | { ok: false; reason: string }> {
  const sdk = await checkedSdk(deps);
  if (!sdk.ok) return sdk;
  const env = deps.env ?? (await userEnv());
  const home = env.HOME || os.homedir();
  const hostPath = resolveElectronResourcePath(deps.app ?? app, HOST);
  return {
    ok: true,
    input: { hostPath, sdkEntry: sdk.entry, env: cursorHostEnv(env, home), cwd: home },
  };
}

/** Whether the tested SDK is here, signed in and on a plan that can run it; starts it once. */
export async function findCursorAgent(deps: CursorLaunchDeps = {}): Promise<CursorAgentCheck> {
  const host = await realHomeHost(deps);
  if (!host.ok) return { status: 'missing', reason: host.reason };
  const give = { failure: CHECKED_NOT, ms: CHECK_MS, what: 'Could not check Cursor' };
  return talkToHost(deps.forkHost ?? forkUtilityHost, host.input, give, (message, talk) => {
    if (turnedDown(message)) talk.settle({ status: 'signed-out', reason: SIGNED_OUT });
    else if (message.type === 'auth') talk.send({ type: 'models' });
    else if (message.type === 'models') {
      saveCursorModels(message.list);
      talk.settle({ status: 'ready' });
    } else if (message.type === 'error' && message.code === 'plan_required') {
      talk.settle({ status: 'plan-required', reason: PLAN_REQUIRED });
    } else if (message.type === 'error') talk.fail(message.text);
  });
}

type SignIn = { done: Promise<boolean>; page?: string };
let signingIn: SignIn | undefined;

/** Runs Cursor's own sign-in in the browser; Cursor keeps the key it makes, Frink never sees it. */
export function signInToCursor(deps: CursorLaunchDeps = {}): Promise<boolean> {
  const openExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  // Another click while one waits opens its page again, as Cursor still waits on that page.
  if (signingIn) {
    if (signingIn.page) void openExternal(signingIn.page).catch((error) => log.warn(error));
    return signingIn.done;
  }
  const pending: SignIn = {
    done: startSignIn(deps, async (url) => {
      // Only secure web pages are opened.
      if (!url.startsWith('https://')) return;
      pending.page = url;
      await openExternal(url);
    }).finally(() => {
      signingIn = undefined;
    }),
  };
  signingIn = pending;
  return pending.done;
}

/** Signs in through a host, handing each page Cursor asks to show to `openPage`. */
async function startSignIn(
  deps: CursorLaunchDeps,
  openPage: (url: string) => Promise<void>,
): Promise<boolean> {
  const host = await realHomeHost(deps);
  if (!host.ok) return false;
  const give = { failure: false, ms: SIGN_IN_MS, what: 'Sign-in did not finish' };
  let loggingIn = false;
  return talkToHost(deps.forkHost ?? forkUtilityHost, host.input, give, (message, talk) => {
    // Signed in means a model list before any login, or the login's own answer after it.
    if (message.type === (loggingIn ? 'auth' : 'models')) talk.settle(true);
    // Only a key Cursor turns down is replaced, so a working sign-in never makes a second key.
    else if (!loggingIn && turnedDown(message)) {
      loggingIn = true;
      talk.send({ type: 'login' });
    } else if (message.type === 'auth') talk.send({ type: 'models' });
    else if (message.type === 'open') void openPage(message.url).catch((e) => talk.fail(String(e)));
    else if (message.type === 'error') talk.fail(message.text);
  });
}

/** Where the SDK's entry is, without starting it. */
export async function locateCursorAgent(deps: SdkDeps = {}) {
  const sdk = await checkedSdk(deps);
  return sdk.ok ? sdk.entry : undefined;
}
