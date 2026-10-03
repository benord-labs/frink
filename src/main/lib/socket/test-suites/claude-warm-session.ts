import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getTaskById } from '../../db/repos/tasks';
import { buildFrinkSystemPromptAppend } from '../../frink-system-prompt';
import { getGlobalMcpServers, getMcpCredentials } from '../../mcp/config';
import * as dynamicChatServer from '../../mcp/dynamic-chat-server';
import { getMultiProjectContext } from '../../multi-project-prompt';
import {
  __resetSessionsForTest,
  getSession,
  retireRetainedSessions,
} from '../claude-session-registry';
import * as wakeHold from '../claude-wake-hold';
import * as socketClient from '../client';
import * as flowCleanup from '../execution/flow-resource-cleanup';
import { abortActiveExecutionsForSubChats, handleRemoteStop } from '../executor';
import { steerActiveTurn } from '../steering';
import { mockQuery, never, UNCLEAN_RESULT } from './claude-turn-abort';
import {
  expireQuestion,
  flowDriven,
  RUNNING_TASK,
  runningTask,
  stopInput,
  TURN_END,
} from './claude-turn-bindings';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type WarmSessionHarness = Pick<ExecutorPermissionHarness, 'basePayload' | 'handleRemoteExecute'> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};
type Payload = Parameters<WarmSessionHarness['handleRemoteExecute']>[0];
type Cli = Parameters<Parameters<typeof mockQuery>[1]>[0];

let payload: WarmSessionHarness['basePayload'];

/** A CLI that answers every prompt it reads, as a warm CLI serves turn after turn. */
export function answeringCli(prompts: SDKUserMessage[] = []) {
  return async function* ({ prompt }: Cli) {
    for (let n = 1; ; n += 1) {
      const next = await prompt.next();
      if (next.done) return;
      prompts.push(next.value);
      yield { chunks: [{ type: 'text-delta', id: `t${n}`, delta: `reply ${n}` }] };
      yield* TURN_END;
    }
  };
}

const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const claimLines = () =>
  vi
    .mocked(log.info)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith(`[Claude Session] claim sub=${payload.subChatId} `))
    .map((line) => line.split(' ').at(-1));
export const replies = () =>
  vi
    .mocked(socketClient.sendStreamChunkDirect)
    .mock.calls.map(([sent]) => (sent.chunk as { delta?: string }).delta)
    .filter(Boolean);
let queryCalls: () => Array<{ options: { resume?: string } }> = () => [];
/** The `resume` the Nth spawned CLI was given. */
const spawnedResume = (call: number) => queryCalls()[call]?.options.resume;
const idle = () => getSession(payload.subChatId)?.retained ?? null;

/** Registers the cases proving an ordinary chat's CLI stays warm between turns: which turn ends
 * keep it, which sends may claim it, and that every other send still gets a correct cold CLI. */
export function registerClaudeWarmSessionTests(harness: WarmSessionHarness): void {
  const { claudeQueryMock } = harness;
  const send = (message: string, overrides: Partial<Payload> = {}) =>
    harness.handleRemoteExecute({ ...payload, message, ...overrides });
  queryCalls = () => claudeQueryMock.mock.calls.map(([input]) => input);

  describe('warm Claude sessions', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
    });
    afterEach(() => __resetSessionsForTest());
    registerWarmHitTests(harness, send);
    registerRecreateTests(harness, send);
    registerNotRetainedTests(harness, send);
    registerClaimRaceTests(harness, send);
  });
}

type Send = (message: string, overrides?: Partial<Payload>) => Promise<void>;

function registerWarmHitTests({ claudeQueryMock }: WarmSessionHarness, send: Send): void {
  it('a second send runs on the same CLI: one query, both replies, a claim hit', async () => {
    const query = mockQuery(claudeQueryMock, answeringCli());

    await send('first');
    expect(idle()).not.toBeNull();
    // The execute's MCP context is cleared at settle even though its session stays.
    expect(dynamicChatServer.clearCurrentExecutionChat).toHaveBeenCalledWith('exec-context-1');
    await send('second', { sessionId: 'sess-held' });

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(query.close).not.toHaveBeenCalled();
    expect(replies()).toEqual(['reply 1', 'reply 2']);
    expect(claimLines()).toEqual(['miss:none', 'hit']);
    expect(query.setPermissionMode).toHaveBeenCalledWith('default');
    expect(idle()).not.toBeNull();
    // Spawn-only preparation (the plans dir among it) ran for the spawn, not for the warm turn.
    const dirs = vi.mocked(fs.mkdirSync).mock.calls.map(([dir]) => `${dir}`);
    expect(dirs.filter((dir) => dir.endsWith('plans'))).toHaveLength(1);
  });

  it('a warm hit pushes only the new message: no history replay, no resume spawn', async () => {
    const prompts: SDKUserMessage[] = [];
    mockQuery(claudeQueryMock, answeringCli(prompts));

    await send('first');
    await send('second', {
      sessionId: 'sess-held',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply 1' },
      ],
    });

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(prompts[1]?.message.content).toBe('second');
  });

  it('a claimed CLI that died silently recovers on a fresh CLI resuming the conversation', async () => {
    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 't1', delta: 'reply 1' }] };
      yield* TURN_END;
      // Dead between turns: the next push meets a stream that just ends.
      await prompt.next();
    });
    mockQuery(claudeQueryMock, answeringCli());

    await send('first');
    await send('second', { sessionId: 'sess-held' });

    // The dead session was claimed; its failure reran once, on a fresh CLI.
    expect(claimLines()).toEqual(['miss:none', 'hit', 'miss:none']);
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(spawnedResume(1)).toBe('sess-held');
    expect(replies()).toEqual(['reply 1', 'reply 1']);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a claimed turn that fails after the model spoke is not rerun: it already ran', async () => {
    mockQuery(claudeQueryMock, async function* ({ prompt }) {
      await prompt.next();
      yield* TURN_END;
      await prompt.next();
      yield { type: 'assistant', chunks: [] };
      throw new Error('CLI crashed mid-turn');
    });

    await send('first');
    await send('second', { sessionId: 'sess-held' });

    expect(claimLines()).toEqual(['miss:none', 'hit']);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
  });

  it('a kept turn counts no other session’s wake hold as its own', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    // A retracted hold of another session, still settling: registered on the chat, never ours.
    const held = vi.spyOn(wakeHold, 'hasWakeHold').mockImplementation((_, session) => !session);
    const completes = vi.mocked(socketClient.sendExecuteCompleteDirect).mock.calls;
    try {
      await send('first');
      await vi.waitFor(() => expect(completes).toHaveLength(1));
    } finally {
      held.mockRestore();
    }

    expect(idle()).not.toBeNull();
    expect(completes[0]?.[0]).toMatchObject({ continuesWakeHold: false });
    expect(dynamicChatServer.clearCurrentExecutionChat).toHaveBeenCalledWith('exec-context-1');
  });
}

function registerRecreateTests({ claudeQueryMock }: WarmSessionHarness, send: Send): void {
  const mcpUrl = { promptPrefix: '', dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp' };
  const linear = async () => ({
    linear: {
      name: 'linear',
      description: 'Linear',
      type: 'cloud_api',
      authType: 'none',
      command: '',
      args: [],
      url: 'https://example.com/mcp',
    },
  });
  const withHeader = (token: string) => {
    vi.mocked(getGlobalMcpServers).mockImplementationOnce(linear as never);
    vi.mocked(getMcpCredentials).mockResolvedValueOnce({
      headers: { Authorization: `Bearer ${token}` },
    });
  };
  const worktree = (worktreePath: string) =>
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce(
      // SAFETY: the executor reads only the chat's worktree, branch and task, and the account.
      { chat: { worktreePath, branch: 'b' }, account: null } as never,
    );

  it.each<[string, string, { first?: () => void; second: () => Partial<Payload> | undefined }]>([
    ['cwd', 'cwd', { second: () => void worktree('/tmp/wt-new') }],
    [
      'api-key',
      // The key rides the fd pipe, not env, so the account change keys through its fingerprint.
      'credential',
      {
        second: () => {
          vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
            token: 'rotated-key',
            isApiKey: true,
            type: 'claude-code',
            label: 'claude-test',
          });
          return undefined;
        },
      },
    ],
    [
      'mcp-header',
      'mcpServers',
      { first: () => withHeader('a'), second: () => void withHeader('b') },
    ],
    [
      'agents-md',
      'systemPrompt',
      {
        second: () =>
          void vi.mocked(buildFrinkSystemPromptAppend).mockResolvedValueOnce('# AGENTS.md changed'),
      },
    ],
    ['max effort', 'effort', { second: () => ({ settings: { effort: 'max' } }) }],
  ])('a changed %s recreates the CLI, resuming the conversation', async (_, part, change) => {
    const first = mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());

    change.first?.();
    await send('first');
    await send('second', { sessionId: 'sess-held', ...change.second() });

    expect(claimLines()).toEqual(['miss:none', `miss:key-mismatch:${part}`]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(spawnedResume(1)).toBe('sess-held');
  });

  it('a plan toggle runs on the same CLI, switching its permission mode live', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());
    vi.mocked(getMultiProjectContext).mockResolvedValueOnce(mcpUrl).mockResolvedValueOnce(mcpUrl);

    await send('first');
    await send('second', { sessionId: 'sess-held', mode: 'plan' });

    expect(claimLines()).toEqual(['miss:none', 'hit']);
    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    expect(warm.setPermissionMode).toHaveBeenLastCalledWith('plan');
  });

  it('a chat whose worktree is gone falls back to the project and recreates there', async () => {
    const first = mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());
    worktree('/tmp/wt-gone');
    await send('first');
    worktree('/tmp/wt-gone');
    vi.mocked(fs.existsSync).mockImplementation((file) => file !== '/tmp/wt-gone');

    await send('second', { sessionId: 'sess-held' });

    expect(claimLines()).toEqual(['miss:none', 'miss:key-mismatch:cwd']);
    expect(first.close).toHaveBeenCalledOnce();
    expect(spawnedResume(1)).toBe('sess-held');
  });

  it('a rolled-back conversation (empty session id) recreates without resume', async () => {
    const first = mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());

    await send('first');
    await send('after rollback', { sessionId: '' });

    expect(claimLines()).toEqual(['miss:none', 'miss:conversation-mismatch']);
    expect(first.close).toHaveBeenCalledOnce();
    expect(spawnedResume(1)).toBeUndefined();
  });
}

/** Ends turn 1 in one of the states the Ruling disposes, not retains. */
const endings: Array<[string, (cli: Cli) => AsyncGenerator<object>, () => Partial<Payload>]> = [
  [
    'aborted',
    async function* ({ prompt }) {
      await prompt.next();
      yield { chunks: [{ type: 'text-delta', id: 's', delta: 'working' }] };
      handleRemoteStop(payload);
      await never();
    },
    () => ({}),
  ],
  [
    'flow-driven',
    answeringCli(),
    () => {
      vi.mocked(getTaskById).mockImplementation(async (_db, id) => runningTask(id));
      flowDriven();
      return {};
    },
  ],
  [
    'is_error',
    async function* ({ prompt }) {
      await prompt.next();
      yield TURN_END[0];
      yield UNCLEAN_RESULT;
      await never();
    },
    () => ({}),
  ],
  [
    'steered',
    async function* ({ prompt }) {
      await prompt.next();
      await steerActiveTurn(payload.subChatId, { text: 'also this' });
      yield* TURN_END;
      await never();
    },
    () => ({}),
  ],
  [
    'after a credential sweep mid-turn',
    async function* ({ prompt }) {
      await prompt.next();
      retireRetainedSessions('credential-change');
      yield* TURN_END;
      await never();
    },
    () => ({}),
  ],
  [
    'after an MCP sweep while it was spawning',
    answeringCli(),
    () => {
      vi.mocked(getMultiProjectContext).mockImplementationOnce(async () => {
        retireRetainedSessions('mcp-config-change');
        return { promptPrefix: '', dynamicChatMcpUrl: null };
      });
      return {};
    },
  ],
  [
    'question-killed',
    async function* ({ prompt, options }) {
      await prompt.next();
      expireQuestion(options.canUseTool);
      await never();
    },
    () => ({}),
  ],
  [
    'finished-follower',
    async function* ({ prompt, options }) {
      await prompt.next();
      const tail = { ...RUNNING_TASK, command: 'tail -f /tmp/s1/tasks/gone.output' };
      await options.hooks.Stop[0].hooks[0]({ ...stopInput([tail]), session_id: 's1' });
      yield* TURN_END;
      await never();
    },
    () => ({}),
  ],
];

/** A Flow-admitted run: provider execution registered against a live admission. */
function admitFlowRun() {
  const release = vi.fn();
  vi.spyOn(flowCleanup, 'registerFlowProviderExecution').mockResolvedValueOnce({
    release,
    rebindAbort: vi.fn(),
    unregisterAbort: vi.fn(),
    prepareAndValidate: (prepare) => prepare(),
    takePendingContinuationResume: () => null,
  });
  return release;
}

function registerNotRetainedTests({ claudeQueryMock }: WarmSessionHarness, send: Send): void {
  it.each(endings)('a turn that ends %s is not kept', async (_, cli, setup) => {
    mockQuery(claudeQueryMock, cli);

    await send('first', setup());

    expect(idle()).toBeNull();
    mockQuery(claudeQueryMock, answeringCli());
    await send('next', { sessionId: 'sess-held' });
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
  });

  it('a Flow-admitted turn is not kept, and its CLI is disposed at settle', async () => {
    const query = mockQuery(claudeQueryMock, answeringCli());
    admitFlowRun();

    await send('flow node');

    expect(idle()).toBeNull();
    expect(getSession(payload.subChatId)).toBeUndefined();
    expect(query.return).toHaveBeenCalled();
  });

  it('a Flow turn retires the chat’s idle CLI and runs on its own, disposed at settle', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());
    const flowCli = mockQuery(claudeQueryMock, answeringCli());
    await send('first');
    const release = admitFlowRun();

    await send('flow node', { sessionId: 'sess-held' });

    expect(claimLines()).toEqual(['miss:none', 'miss:flow-turn']);
    expect(warm.close).toHaveBeenCalledOnce();
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(flowCli.return).toHaveBeenCalled();
    expect(getSession(payload.subChatId)).toBeUndefined();
    expect(release).toHaveBeenCalled();
  });
}

function registerClaimRaceTests({ claudeQueryMock }: WarmSessionHarness, send: Send): void {
  it('a duplicate during the claimed turn’s awaited reconcile waits for it, then spawns', async () => {
    const prompts: SDKUserMessage[] = [];
    const warm = mockQuery(claudeQueryMock, answeringCli(prompts));
    await send('first');
    const reconcile = deferred();
    warm.setPermissionMode.mockImplementationOnce(() => reconcile.promise);
    // The abort's close lands late, as a real CLI's exit does.
    warm.close.mockImplementationOnce(() => {});
    const claimed = send('second', { sessionId: 'sess-held', assistantMessageId: 'msg-2' });
    await vi.waitFor(() => expect(warm.setPermissionMode).toHaveBeenCalled());

    mockQuery(claudeQueryMock, answeringCli());
    const duplicate = send('third', { sessionId: 'sess-held', assistantMessageId: 'msg-3' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claudeQueryMock).toHaveBeenCalledOnce();

    reconcile.release();
    await Promise.all([claimed, duplicate]);

    expect(prompts.map((p) => p.message.content)).toEqual([expect.any(String)]);
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
    expect(socketClient.sendStreamChunkDirect).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: 'msg-3', chunk: expect.anything() }),
    );
  });

  it('a delete between claim and push aborts the turn: one close, nothing pushed', async () => {
    const prompts: SDKUserMessage[] = [];
    const warm = mockQuery(claudeQueryMock, answeringCli(prompts));
    await send('first');
    const reconcile = deferred();
    warm.setPermissionMode.mockImplementationOnce(() => reconcile.promise);
    const claimed = send('second', { sessionId: 'sess-held' });
    await vi.waitFor(() => expect(warm.setPermissionMode).toHaveBeenCalled());

    abortActiveExecutionsForSubChats([payload.subChatId], 'chat deleted');
    reconcile.release();
    await claimed;

    expect(warm.close).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(getSession(payload.subChatId)).toBeUndefined();
  });
}
