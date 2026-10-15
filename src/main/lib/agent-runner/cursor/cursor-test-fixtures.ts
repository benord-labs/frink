import { chmod, lstat, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { JsonValue } from '../../../../shared/types/permissions';
import type { CursorSdkMessage } from './cursor-events';
import type { CursorHostMessage, CursorHostRequest, ForkHost } from './cursor-runner';

type Flag = 'uchg' | 'nouchg';
type StartRequest = Extract<CursorHostRequest, { type: 'start' }>;

/** Stands in for chflags: a lock removes write permission and an unlock restores it. */
export function recordingChflags() {
  const calls: Array<[Flag, string[]]> = [];
  const chflags = async (flag: Flag, paths: string[]) => {
    calls.push([flag, paths]);
    for (const file of paths) {
      const info = await lstat(file);
      if (!info.isSymbolicLink()) {
        await chmod(file, flag === 'uchg' ? info.mode & 0o555 : info.mode | 0o200);
      }
    }
  };
  return { chflags, calls };
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
