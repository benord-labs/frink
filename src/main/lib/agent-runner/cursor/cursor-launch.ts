import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { resolveElectronResourcePath } from '../../platform/electron-resource-path';
import { userEnv } from '../acp/agents/launch';
import { cursorHostEnv } from './cursor-home';
import {
  type CursorRunnerParams,
  type ForkHost,
  forkUtilityHost,
  PLAN_REQUIRED,
  SIGNED_OUT,
} from './cursor-runner';
import { CURSOR_TOOL_NAMES } from './cursor-tools';

type Env = Record<string, string>;
type AppPaths = { isPackaged: boolean; getAppPath(): string; getPath(name: 'userData'): string };
export type CursorLaunchDeps = { env?: Env; app?: AppPaths; sdkRoot?: string; forkHost?: ForkHost };
type SdkCheck = { ok: true; entry: string } | { ok: false; reason: string };
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
const NO_SDK = "Frink can't find Cursor's SDK on this computer.";
const BAD_CHAT = "Frink can't start Cursor for this chat.";
const CHECK_FAILED = "Frink couldn't reach Cursor. Try again in a moment.";
const packageSchema = z.object({ name: z.literal('@cursor/sdk'), version: z.string() });
const nodeRequire = createRequire(import.meta.url);

function installedSdkRoot(): string | undefined {
  try {
    return path.resolve(nodeRequire.resolve('@cursor/sdk'), '..', '..', '..');
  } catch {
    return undefined;
  }
}

const readVersion = (root: string) =>
  readFile(path.join(root, 'package.json'), 'utf8')
    .then((text) => packageSchema.parse(JSON.parse(text)).version)
    .catch(() => undefined);

/** The SDK's module entry when the copy found is the tested version, or why it can't be used. */
async function checkedSdk(root = installedSdkRoot()): Promise<SdkCheck> {
  const version = root && (await readVersion(root));
  if (!root || !version) return { ok: false, reason: NO_SDK };
  if (version !== CURSOR_ROW.sdk.version) {
    return {
      ok: false,
      reason: `Frink checked Cursor's SDK ${CURSOR_ROW.sdk.version}. This copy is ${version}.`,
    };
  }
  return { ok: true, entry: path.join(root, 'dist', 'esm', 'index.js') };
}

/** Prepares one turn's launch, checked before every turn so a changed install is caught. */
export async function resolveCursorLaunch(
  input: { chatKey: string },
  deps: CursorLaunchDeps = {},
): Promise<{ ok: true; launch: CursorRunnerParams['launch'] } | { ok: false; reason: string }> {
  if (!CHAT_KEY.test(input.chatKey)) return { ok: false, reason: BAD_CHAT };
  const sdk = await checkedSdk(deps.sdkRoot);
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
      env: cursorHostEnv(env, home),
      home,
      storeDir: path.join(chat, 'store'),
      realHome: env.HOME || os.homedir(),
      tools: CURSOR_ROW.tools,
      hookVersions: CURSOR_ROW.hookVersions,
    },
  };
}

/** Asks a host whether Cursor is signed in and lets this account list models. */
function askHost(forkHost: ForkHost, input: Parameters<ForkHost>[0]): Promise<CursorAgentCheck> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (check: CursorAgentCheck) => {
      settled = true;
      clearTimeout(timer);
      host.kill();
      resolve(check);
    };
    const failed = (text: string) => {
      // Settling kills the host, so its exit then is expected.
      if (settled) return;
      log.warn(`[Cursor] Could not check Cursor: ${text}`);
      settle({ status: 'failed', reason: CHECK_FAILED });
    };
    const timer = setTimeout(() => failed('no answer'), CHECK_MS);
    const host = forkHost(input, {
      message: (message) => {
        if (message.type === 'auth' && message.status === 'logged-in')
          host.send({ type: 'models' });
        else if (message.type === 'auth') settle({ status: 'signed-out', reason: SIGNED_OUT });
        else if (message.type === 'models') settle({ status: 'ready' });
        else if (message.type === 'error' && message.code === 'plan_required') {
          settle({ status: 'plan-required', reason: PLAN_REQUIRED });
        } else if (message.type === 'error') failed(message.text);
      },
      exit: () => failed('the host stopped'),
    });
  });
}

/** Whether the tested SDK is here, signed in and on a plan that can run it; starts it once. */
export async function findCursorAgent(deps: CursorLaunchDeps = {}): Promise<CursorAgentCheck> {
  const sdk = await checkedSdk(deps.sdkRoot);
  if (!sdk.ok) return { status: 'missing', reason: sdk.reason };
  const env = deps.env ?? (await userEnv());
  const home = env.HOME || os.homedir();
  return askHost(deps.forkHost ?? forkUtilityHost, {
    hostPath: resolveElectronResourcePath(deps.app ?? app, HOST),
    sdkEntry: sdk.entry,
    env: cursorHostEnv(env, home),
    cwd: home,
  });
}

/** Where the SDK's entry is, without starting it. */
export async function locateCursorAgent(deps: Pick<CursorLaunchDeps, 'sdkRoot'> = {}) {
  const sdk = await checkedSdk(deps.sdkRoot);
  return sdk.ok ? sdk.entry : undefined;
}
