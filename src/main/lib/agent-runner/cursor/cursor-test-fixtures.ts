import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../../../../shared/types/permissions';
import type { CursorSdkMessage } from './cursor-events';
import { type HomeLock, modeLock } from './cursor-home';
import type { CursorHostMessage, CursorHostRequest, ForkHost } from './cursor-runner';
import { cursorRipgrepIn } from './cursor-tools';

/** The ripgrep Cursor's SDK ships for this computer, as the launch finds it beside the SDK. */
export const CURSOR_RIPGREP = cursorRipgrepIn(path.resolve());

type StartRequest = Extract<CursorHostRequest, { type: 'start' }>;

/** Records each lock and unlock, then applies the real write-bit lock. */
export function recordingLock() {
  const calls: Array<[on: boolean, paths: string[]]> = [];
  const lock: HomeLock = async (on, paths) => {
    calls.push([on, paths]);
    await modeLock(on, paths);
  };
  return { lock, calls };
}

const IDS = { agent_id: 'agent-1', run_id: 'run-1' };

export const sdk = {
  says: (text: string): CursorSdkMessage => ({
    type: 'assistant',
    ...IDS,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }),
  thinks: (text: string): CursorSdkMessage => ({ type: 'thinking', ...IDS, text }),
  status: (status: 'RUNNING' | 'FINISHED'): CursorSdkMessage => ({
    type: 'status',
    ...IDS,
    status,
  }),
  runs: (call_id: string, name: string, args: JsonValue): CursorSdkMessage => ({
    type: 'tool_call',
    ...IDS,
    call_id,
    name,
    status: 'running',
    args,
  }),
  ran: (
    call_id: string,
    name: string,
    args: JsonValue,
    result: JsonValue,
    status: 'completed' | 'error' = 'completed',
  ): CursorSdkMessage => ({
    type: 'tool_call',
    ...IDS,
    call_id,
    name,
    status,
    args,
    result,
  }),
  usage: (inputTokens: number, outputTokens: number): CursorSdkMessage => ({
    type: 'usage',
    ...IDS,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
  }),
};

/** A hook call as Cursor's hook program sends it. */
export const hookCall = (event: string, fields: Record<string, JsonValue> = {}) => ({
  hook_event_name: event,
  cursor_version: '1.0.0',
  ...fields,
});

const hooksFileSchema = z.object({
  hooks: z.object({ preToolUse: z.array(z.object({ command: z.string() })) }),
});

/** Posts one hook call to the gate the private home's hooks.json names, as the wrapper does. */
async function callGate(home: string, body: JsonValue): Promise<JsonValue> {
  const hooks = hooksFileSchema.parse(
    JSON.parse(await readFile(path.join(home, '.cursor', 'hooks.json'), 'utf8')),
  );
  const socketPath = path.join(path.dirname(hooks.hooks.preToolUse[0].command), 'g.sock');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/hook', method: 'POST' }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      res.on('end', () => resolve(z.json().parse(JSON.parse(text))));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** One turn as the fake host plays it. */
export type FakePlay = {
  start: StartRequest;
  post(message: CursorHostMessage): void;
  sdk(message: CursorSdkMessage): void;
  /** Posts JSON unchecked, as Electron hands a host's message over. */
  raw(json: string): void;
  hook(body: JsonValue): Promise<JsonValue>;
};

type FakeHostSetup = {
  auth?: string;
  resumeFails?: boolean;
  /** Plays the turn after `start`; by default the run finishes at once. */
  turn?: (play: FakePlay) => void | Promise<void>;
  /** Runs when the host is asked to cancel; by default the host then exits. */
  onCancel?: (play: FakePlay) => void | Promise<void>;
  /** A killed host exits only after this many milliseconds. */
  exitAfterKillMs?: number;
};

/** A Cursor host double that records what Frink sends it and whether it was killed. */
export function fakeCursorHost(setup: FakeHostSetup = {}) {
  const received: CursorHostRequest[] = [];
  const forks: Array<Parameters<ForkHost>[0]> = [];
  let kills = 0;
  let gone = false;
  const forkHost: ForkHost = (input, events) => {
    forks.push(input);
    let exited = false;
    let play: FakePlay | undefined;
    const exit = () => {
      if (!exited) events.exit();
      exited = true;
      gone = true;
    };
    void Promise.resolve().then(() =>
      events.message({ type: 'auth', status: setup.auth ?? 'logged-in' }),
    );
    return {
      send(message) {
        received.push(message);
        if (message.type === 'cancel') {
          if (!setup.onCancel) return exit();
          if (play) void setup.onCancel(play);
          return;
        }
        if (message.type !== 'start') return;
        const resumed = Boolean(message.resumeAgentId) && !setup.resumeFails;
        const agentId = resumed && message.resumeAgentId ? message.resumeAgentId : 'agent-1';
        events.message({ type: 'agent', agentId, resumed });
        play = {
          start: message,
          post: (reply) => events.message(reply),
          sdk: (sdkMessage) => events.message({ type: 'sdk', message: sdkMessage }),
          raw: (json) => events.message(JSON.parse(json)),
          hook: (body) => callGate(input.env.HOME, body),
        };
        const turn =
          setup.turn ?? ((it: FakePlay) => it.post({ type: 'result', status: 'finished' }));
        void Promise.resolve(play).then(turn);
      },
      kill() {
        kills += 1;
        if (setup.exitAfterKillMs) setTimeout(exit, setup.exitAfterKillMs);
        else exit();
      },
    };
  };
  return { forkHost, received, forks, kills: () => kills, exited: () => gone };
}

/** Starts the host file under Node; Frink itself starts it as an Electron utility process. */
export const nodeForkHost: ForkHost = ({ hostPath, sdkEntry, env, cwd }, events) => {
  const child = fork(hostPath, [sdkEntry], { env, cwd, stdio: 'ignore' });
  // SAFETY: the host is Frink's own file and posts only CursorHostMessage values.
  child.on('message', (message) => events.message(message as CursorHostMessage));
  child.once('exit', events.exit);
  child.on('error', events.exit);
  return { send: (request) => void child.send(request), kill: () => void child.kill() };
};

/** The models the stand-in SDK lists: Auto and one model with an effort choice. */
export const FAKE_CURSOR_MODELS = [
  { id: 'default', displayName: 'Auto', parameters: [] },
  {
    id: 'gpt-x',
    displayName: 'GPT-X',
    parameters: [{ id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] }],
    variants: [
      {
        params: [{ id: 'reasoning_effort', value: 'high' }],
        displayName: 'GPT-X',
        isDefault: true,
      },
    ],
  },
];

// Stands in for Cursor's SDK: FAKE_AUTH and FAKE_MODELS steer it, and each turn asks the gate first.
const FAKE_SDK = `import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
export class JsonlLocalAgentStore { constructor(dir) { this.dir = dir; } }
const FAKE_MODELS = ${JSON.stringify(FAKE_CURSOR_MODELS)};
export const Cursor = {
  auth: {
    status: async () => ({ status: process.env.FAKE_AUTH ?? 'logged-in' }),
    login: async ({ apiKeyName, openBrowser }) => {
      if (apiKeyName !== 'Frink' || process.env.FAKE_LOGIN === 'fail') throw new Error('Login failed');
      await openBrowser(process.env.FAKE_LOGIN_URL);
      if (process.env.FAKE_LOGIN === 'wait') await new Promise(() => {});
      return { apiKey: 'secret-key', apiKeyExpiresAtMs: 0 };
    },
  },
  models: { list: async () => {
    if (process.env.FAKE_MODELS === 'hang') return new Promise(() => {});
    if (process.env.FAKE_MODELS) throw Object.assign(new Error('No plan'), { code: process.env.FAKE_MODELS });
    return FAKE_MODELS;
  } },
};
const ids = { agent_id: 'a', run_id: 'r' };
function canary() {
  const hooks = JSON.parse(readFileSync(path.join(process.env.HOME, '.cursor', 'hooks.json'), 'utf8'));
  const socketPath = path.join(path.dirname(hooks.hooks.beforeSubmitPrompt[0].command), 'g.sock');
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/hook', method: 'POST' }, (res) => res.resume().on('end', resolve));
    req.end(JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', cursor_version: '1.0.0' }));
  });
}
function agent(agentId, options) {
  return {
    agentId,
    close() {},
    async send(message, sendOptions) {
      if (message.text === 'refuse') throw Object.assign(new Error('No plan'), { code: 'plan_required' });
      const seen = { text: message.text, images: message.images?.length ?? 0, mode: sendOptions?.mode,
        model: options.model, tools: options.tools, local: { ...options.local, store: options.local.store instanceof JsonlLocalAgentStore } };
      return {
        cancel: async () => {},
        wait: async () => ({ status: 'finished' }),
        async *stream() {
          yield { type: 'status', status: 'RUNNING', ...ids };
          await canary();
          yield { type: 'assistant', ...ids, message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(seen) }] } };
        },
      };
    },
  };
}
export const Agent = {
  create: async (options) => agent('agent-new', options),
  resume: async (agentId, options) => {
    if (agentId === 'gone') throw new Error('Agent not found');
    return agent(agentId, options);
  },
};
`;

/** Writes a stand-in SDK package where Frink looks for Cursor's, at the given version. */
export async function writeFakeCursorSdk(root: string, version: string): Promise<void> {
  await mkdir(path.join(root, 'dist', 'esm'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@cursor/sdk', version }),
  );
  await writeFile(path.join(root, 'dist', 'esm', 'index.js'), FAKE_SDK);
}
