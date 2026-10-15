import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@cursor/sdk';
import log from 'electron-log';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import * as database from '../../db';
import { freshDb } from '../../db/test-utils/fresh-db';
import { collectChunks, textOf } from '../acp/acp-test-fixtures';
import { rememberedAgentModels } from '../agent-models';
import type { CursorSdkMessage } from './cursor-events';
import type { CursorRunnerParams, ForkHost } from './cursor-runner';
import {
  CURSOR_RIPGREP,
  FAKE_CURSOR_MODELS,
  nodeForkHost,
  recordingChflags,
  writeFakeCursorSdk,
} from './cursor-test-fixtures';
import {
  CURSOR_TOOL_NAMES,
  cursorHostEnv,
  disposeAllCursorHosts,
  findCursorAgent,
  locateCursorAgent,
  resolveCursorLaunch,
  runCursorAgent,
  signInToCursor,
} from './index';

const PLAN_REQUIRED =
  'Cursor needs a paid plan to work in Frink. Upgrade to Cursor Pro or higher, then try again.';
const SIGNED_OUT =
  "Cursor isn't signed in. Choose Sign in to Cursor, finish in your browser, then try again.";
const NO_SDK = "Frink can't find Cursor's SDK on this computer.";
const SAVED_ROWS = [
  { id: 'default', name: 'Auto' },
  { id: 'gpt-x/low', name: 'GPT-X', familyId: 'gpt-x', effort: 'low', detail: 'Low' },
  { id: 'gpt-x/high', name: 'GPT-X', familyId: 'gpt-x', effort: 'high', detail: 'High' },
];
const NO_RIPGREP =
  'Part of Cursor is missing from this copy of Frink. Reinstall Frink, then try again.';

let root = '';
let sdkRoot = '';
let userData = '';
let realHome = '';
let chat = 0;

beforeAll(async () => {
  // A space in the path, as in macOS's Application Support folder.
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor launch '));
  // Run from source: the SDK and its platform package share one node_modules.
  sdkRoot = path.join(root, 'source', 'node_modules', '@cursor', 'sdk');
  userData = path.join(root, 'App Support');
  realHome = path.join(root, 'real home');
  await mkdir(realHome);
  await writeFakeCursorSdk(sdkRoot, '1.0.37');
  await writeCursorRipgrep(path.join(root, 'source', 'node_modules'));
});
beforeEach(() => {
  vi.spyOn(database, 'getDatabase').mockReturnValue(freshDb());
});
afterEach(() => {
  vi.useRealTimers();
  return disposeAllCursorHosts();
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** Puts Cursor's platform package, with a working ripgrep, in a node_modules folder. */
async function writeCursorRipgrep(nodeModules: string) {
  const bin = path.join(nodeModules, '@cursor', `sdk-${process.platform}-${process.arch}`, 'bin');
  await mkdir(bin, { recursive: true });
  await symlink(CURSOR_RIPGREP, path.join(bin, 'rg'));
  return path.join(bin, 'rg');
}

const app = { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => userData };
const userEnv = (extra: Record<string, string> = {}) => ({
  PATH: '/usr/bin:/bin',
  HOME: realHome,
  SHELL: '/bin/zsh',
  ...extra,
});
const deps = (extra: Record<string, string> = {}, more: { sdkRoot?: string } = {}) => ({
  env: userEnv(extra),
  app,
  sdkRoot,
  forkHost: nodeForkHost,
  ...more,
});

async function launchFor(extra: Record<string, string> = {}) {
  chat += 1;
  const result = await resolveCursorLaunch({ chatKey: `chat-${chat}` }, deps(extra));
  if (!result.ok) throw new Error(result.reason);
  return result.launch;
}

describe('resolveCursorLaunch', () => {
  it('starts the tested SDK through Frink’s host, with a private home and store per chat', async () => {
    const chatDir = path.join(userData, 'cursor', 'chats', 'c_1-A');
    const home = path.join(chatDir, 'home');
    const env = userEnv({ CURSOR_API_KEY: 'kept', CURSOR_BACKEND_URL: 'http://127.0.0.1:1' });
    const platform = `sdk-${process.platform}-${process.arch}`;
    const ripgrep = path.join(path.dirname(sdkRoot), platform, 'bin', 'rg');

    expect(await resolveCursorLaunch({ chatKey: 'c_1-A' }, { env, app, sdkRoot })).toEqual({
      ok: true,
      launch: {
        sdkEntry: path.join(sdkRoot, 'dist', 'esm', 'index.js'),
        hostPath: path.join(process.cwd(), 'resources', 'cursor', 'cursor-host.mjs'),
        env: { ...cursorHostEnv(env, home), CURSOR_RIPGREP_PATH: ripgrep },
        home,
        storeDir: path.join(chatDir, 'store'),
        realHome,
        ripgrep,
        tools: CURSOR_TOOL_NAMES,
        hookVersions: ['1.0.0'],
      },
    });
    expect(cursorHostEnv(env, home)).toMatchObject({ HOME: home, CURSOR_API_KEY: 'kept' });
    expect(cursorHostEnv(env, home)).not.toHaveProperty('CURSOR_BACKEND_URL');
  });

  it('refuses another SDK version, a missing SDK and a chat key that names another folder', async () => {
    const old = path.join(root, 'old sdk');
    await writeFakeCursorSdk(old, '1.0.36');
    const resolve = (chatKey: string, from = sdkRoot) =>
      resolveCursorLaunch({ chatKey }, { env: userEnv(), app, sdkRoot: from });

    expect(await resolve('c1', old)).toEqual({
      ok: false,
      reason: "Frink checked Cursor's SDK 1.0.37. This copy is 1.0.36.",
    });
    expect(await resolve('c1', path.join(root, 'none'))).toEqual({ ok: false, reason: NO_SDK });
    for (const chatKey of ['../c1', 'a/b', '', '.']) {
      expect(await resolve(chatKey)).toEqual({
        ok: false,
        reason: "Frink can't start Cursor for this chat.",
      });
    }
  });
});

describe('the pinned SDK', () => {
  it('sends only messages Frink’s copy of their types describes', () => {
    expectTypeOf<SDKMessage>().toExtend<CursorSdkMessage>();
  });
});

describe('locateCursorAgent', () => {
  it('names the SDK entry when the SDK is there, without starting it', async () => {
    expect(await locateCursorAgent({ sdkRoot })).toBe(
      path.join(sdkRoot, 'dist', 'esm', 'index.js'),
    );
    expect(await locateCursorAgent({ sdkRoot: path.join(root, 'none') })).toBeUndefined();
  });

  it("finds the SDK installed with Frink's own packages when run from source", async () => {
    expect(await locateCursorAgent({ app })).toBe(
      path.join(process.cwd(), 'node_modules', '@cursor', 'sdk', 'dist', 'esm', 'index.js'),
    );
  });

  it('finds the SDK inside the built app and its ripgrep outside it, and refuses a broken copy', async () => {
    const resources = (name: string) => path.join(root, name, 'Contents', 'Resources');
    // The SDK and its ripgrep are found from the app path alone.
    const built = (name: string) => ({
      ...app,
      getAppPath: () => path.join(resources(name), 'app.asar'),
    });
    const shipped = (name: string) =>
      path.join(resources(name), 'app.asar', 'node_modules', '@cursor', 'sdk');
    await writeFakeCursorSdk(shipped('built'), '1.0.37');
    await writeFakeCursorSdk(shipped('built no rg'), '1.0.37');
    await writeFakeCursorSdk(shipped('built old'), '1.0.36');
    const ripgrep = await writeCursorRipgrep(path.join(resources('built'), 'node_modules'));
    const launch = (name: string) =>
      resolveCursorLaunch({ chatKey: 'c1' }, { env: userEnv(), app: built(name) });

    expect(await locateCursorAgent({ app: built('built') })).toBe(
      path.join(shipped('built'), 'dist', 'esm', 'index.js'),
    );
    expect(await launch('built')).toMatchObject({
      ok: true,
      launch: { ripgrep, env: { CURSOR_RIPGREP_PATH: ripgrep } },
    });
    expect(await launch('built no rg')).toEqual({ ok: false, reason: NO_RIPGREP });
    expect(await launch('built missing')).toEqual({ ok: false, reason: NO_SDK });
    expect(await launch('built old')).toEqual({
      ok: false,
      reason: "Frink checked Cursor's SDK 1.0.37. This copy is 1.0.36.",
    });
  });
});

describe('findCursorAgent', () => {
  it.each([
    ['signed in with a paid plan', {}, { status: 'ready' }],
    [
      'signed in only by the user’s own key',
      { FAKE_AUTH: 'logged-out', CURSOR_API_KEY: 'k' },
      { status: 'ready' },
    ],
    ['signed out', { FAKE_AUTH: 'logged-out' }, { status: 'signed-out', reason: SIGNED_OUT }],
    [
      'an empty key',
      { FAKE_AUTH: 'logged-out', CURSOR_API_KEY: '' },
      { status: 'signed-out', reason: SIGNED_OUT },
    ],
    [
      'a stored key Cursor turned down',
      { FAKE_MODELS: 'unauthenticated' },
      { status: 'signed-out', reason: SIGNED_OUT },
    ],
    [
      'on a free plan',
      { FAKE_MODELS: 'plan_required' },
      { status: 'plan-required', reason: PLAN_REQUIRED },
    ],
  ])('reports %s, with no warning', async (_name, extra, expected) => {
    const warn = vi.spyOn(log, 'warn');
    let done = () => {};
    const exited = new Promise<void>((resolve) => (done = resolve));
    const forkHost: ForkHost = (input, events) =>
      nodeForkHost(input, {
        ...events,
        exit: () => {
          events.exit();
          done();
        },
      });
    expect(await findCursorAgent({ ...deps(extra), forkHost })).toEqual(expected);
    await exited;
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('saves the models Cursor lists while it checks, for the picker and Settings', async () => {
    expect(await findCursorAgent(deps())).toEqual({ status: 'ready' });
    expect(rememberedAgentModels('cursor')).toMatchObject(SAVED_ROWS);
    expect(rememberedAgentModels('cursor')[2]).toMatchObject({ effortDefault: true });
  });

  it("checks with the user's real home, where Cursor keeps its own sign-in", async () => {
    const forks: Parameters<ForkHost>[0][] = [];
    const forkHost: ForkHost = (input, events) => {
      forks.push(input);
      return nodeForkHost(input, events);
    };
    await findCursorAgent({ ...deps(), forkHost });
    expect(forks[0]).toMatchObject({ cwd: realHome, env: { HOME: realHome } });
  });

  it('reports a missing SDK without starting anything', async () => {
    let forks = 0;
    const forkHost: ForkHost = (input, events) => {
      forks += 1;
      return nodeForkHost(input, events);
    };
    expect(
      await findCursorAgent({ ...deps({}, { sdkRoot: path.join(root, 'none') }), forkHost }),
    ).toEqual({ status: 'missing', reason: NO_SDK });
    expect(forks).toBe(0);
  });
});

describe('signInToCursor', () => {
  const PAGE = 'https://cursor.com/loginDeepControl?uuid=1';

  /** Signs in through the real host and the stand-in SDK, recording what crossed and what opened. */
  function signIn(extra: Record<string, string>) {
    const opened: string[] = [];
    const seen: unknown[] = [];
    const forks: Parameters<ForkHost>[0][] = [];
    const hosts: ReturnType<ForkHost>[] = [];
    const forkHost: ForkHost = (input, events) => {
      forks.push(input);
      const host = nodeForkHost(input, {
        ...events,
        message: (message) => {
          seen.push(message);
          events.message(message);
        },
      });
      hosts.push(host);
      return host;
    };
    const openExternal = async (url: string) => void opened.push(url);
    const signedIn = signInToCursor({ ...deps(extra), forkHost, openExternal });
    return { signedIn, opened, seen, forks, hosts };
  }

  it("opens Cursor's own sign-in page with the user's real home, and never sees the key", async () => {
    const { signedIn, opened, seen, forks } = signIn({
      FAKE_AUTH: 'logged-out',
      FAKE_LOGIN_URL: PAGE,
    });

    expect(await signedIn).toBe(true);
    expect(opened).toEqual([PAGE]);
    expect(forks).toEqual([expect.objectContaining({ cwd: realHome, env: expect.anything() })]);
    expect(forks[0]?.env.HOME).toBe(realHome);
    expect(JSON.stringify(seen)).not.toContain('secret-key');
  });

  it('makes no new key when Cursor is already signed in', async () => {
    const { signedIn, opened, seen } = signIn({});

    expect(await signedIn).toBe(true);
    expect(opened).toEqual([]);
    expect(seen).toEqual([
      { type: 'auth', status: 'logged-in' },
      { type: 'models', list: FAKE_CURSOR_MODELS },
    ]);
  });

  it('signs in again when Cursor turns down the key it has stored', async () => {
    const { signedIn, opened } = signIn({ FAKE_MODELS: 'unauthenticated', FAKE_LOGIN_URL: PAGE });

    expect(await signedIn).toBe(true);
    expect(opened).toEqual([PAGE]);
  });

  it('reports a sign-in that failed, and opens only secure web pages', async () => {
    expect(await signIn({ FAKE_AUTH: 'logged-out', FAKE_LOGIN: 'fail' }).signedIn).toBe(false);

    const odd = signIn({ FAKE_AUTH: 'logged-out', FAKE_LOGIN_URL: 'file:///etc/hosts' });
    await odd.signedIn;
    expect(odd.opened).toEqual([]);
  });

  it('runs one sign-in at a time, so a second click makes no second key', async () => {
    const first = signIn({ FAKE_AUTH: 'logged-out', FAKE_LOGIN_URL: PAGE });
    const second = signIn({ FAKE_AUTH: 'logged-out', FAKE_LOGIN_URL: PAGE });

    expect(await Promise.all([first.signedIn, second.signedIn])).toEqual([true, true]);
    expect(first.forks.length + second.forks.length).toBe(1);
  });

  it('opens the waiting page again when asked a second time', async () => {
    const first = signIn({ FAKE_AUTH: 'logged-out', FAKE_LOGIN_URL: PAGE, FAKE_LOGIN: 'wait' });
    await vi.waitFor(() => expect(first.opened).toEqual([PAGE]));
    const again = signIn({});

    expect(again.opened).toEqual([PAGE]);
    expect(again.forks).toEqual([]);
    first.hosts[0]?.kill();
    expect(await again.signedIn).toBe(false);
  });

  it('answers in plain words when the host cannot start, and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const forkHost: ForkHost = () => {
      throw new Error('spawn EACCES /private/raw/path');
    };

    expect(await findCursorAgent({ ...deps(), forkHost })).toEqual({
      status: 'failed',
      reason: "Frink couldn't reach Cursor. Try again in a moment.",
    });
    expect(await signInToCursor({ ...deps(), forkHost })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the Cursor host', () => {
  /** Runs one turn through the real host file and the stand-in SDK, recording what crossed the process. */
  async function hostTurn(overrides: Partial<CursorRunnerParams> = {}, extra = {}) {
    const order: string[] = [];
    const forkHost: ForkHost = (input, events) => {
      const host = nodeForkHost(input, {
        message: (message) => {
          order.push(message.type);
          // Held back, so a host that exits on its own after its result shows up in the order.
          if (message.type === 'result') setTimeout(() => events.message(message), 300);
          else events.message(message);
        },
        exit: () => {
          order.push('exit');
          events.exit();
        },
      });
      return {
        send: (request) => {
          order.push(`send ${request.type}`);
          host.send(request);
        },
        kill: () => {
          order.push('kill');
          host.kill();
        },
      };
    };
    const params: CursorRunnerParams = {
      launch: overrides.launch ?? (await launchFor(extra)),
      cwd: root,
      prompt: 'hello',
      abortController: new AbortController(),
      checkApproval: async () => ({ allowed: true }),
      ...overrides,
    };
    const chunks = await collectChunks(
      runCursorAgent(params, { forkHost, chflags: recordingChflags().chflags }),
    );
    await disposeAllCursorHosts();
    return { chunks, order, launch: params.launch, seen: JSON.parse(textOf(chunks) || '{}') };
  }

  const errorsOf = (chunks: UIMessageChunk[]) =>
    chunks.flatMap((chunk) => (chunk.type === 'error' ? [chunk.errorText] : []));

  it('signs in once, runs the turn, and exits only when Frink cancels it', async () => {
    const { chunks, order, seen } = await hostTurn();

    expect(errorsOf(chunks)).toEqual([]);
    expect(order.filter((type) => type !== 'models')).toEqual([
      'auth',
      'send start',
      'agent',
      'sdk',
      'sdk',
      'result',
      'send cancel',
      'exit',
    ]);
    expect(seen).toEqual({
      text: 'hello',
      images: 0,
      model: { id: 'default' },
      tools: CURSOR_TOOL_NAMES,
      local: { cwd: root, settingSources: ['user'], store: true },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'agent-new' } });
  });

  it('passes Plan mode and images, and continues an earlier agent in its folder', async () => {
    const { launch } = await hostTurn();
    const images = [{ data: 'aGk=', mimeType: 'image/png' }];
    const { chunks, seen } = await hostTurn({
      launch,
      mode: 'plan',
      images,
      resumeSessionId: 'agent-7',
    });

    expect(seen).toMatchObject({ text: 'hello', images: 1, mode: 'plan' });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'agent-7' } });
  });

  it('sends the chat so far to a new agent when the earlier one is gone', async () => {
    const { launch } = await hostTurn();
    const { chunks, seen } = await hostTurn({
      launch,
      resumeSessionId: 'gone',
      freshSessionFallbackPrompt: 'history then hello',
    });

    expect(seen).toMatchObject({ text: 'history then hello' });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: { sessionId: 'agent-new' } });
  });

  it('ends with the sign-in text and starts nothing when Cursor is signed out', async () => {
    const { chunks, order } = await hostTurn({}, { FAKE_AUTH: 'logged-out' });

    expect(errorsOf(chunks)).toEqual([SIGNED_OUT]);
    expect(order).not.toContain('send start');
  });

  it('shows the paid-plan text when Cursor refuses the turn', async () => {
    const { chunks } = await hostTurn({ prompt: 'refuse' });

    expect(errorsOf(chunks)).toEqual([PLAN_REQUIRED]);
  });

  it('sends the chosen model, then saves the models Cursor lists after the turn starts', async () => {
    const model = { id: 'gpt-x', params: [{ id: 'reasoning_effort', value: 'low' }] };
    const { order, seen } = await hostTurn({ model });

    expect(seen).toMatchObject({ model });
    expect(order.indexOf('models')).toBeGreaterThan(order.indexOf('send start'));
    expect(rememberedAgentModels('cursor')).toMatchObject(SAVED_ROWS);
  });

  it('never waits on the model list to stream the turn', async () => {
    const { chunks, order } = await hostTurn({}, { FAKE_MODELS: 'hang' });

    expect(errorsOf(chunks)).toEqual([]);
    expect(textOf(chunks)).toContain('hello');
    expect(order).not.toContain('models');
  });
});
