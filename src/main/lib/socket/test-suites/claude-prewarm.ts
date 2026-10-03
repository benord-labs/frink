import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { getClaudeCodeTokenById, getDefaultClaudeCodeToken } from '../../credentials';
import { getChatWithProjectAccount } from '../../db/repos/chats';
import { getSubChatById } from '../../db/repos/sub-chats';
import { getLatestFlowTaskForSubChat } from '../../db/repos/tasks';
import { getGlobalMcpServers } from '../../mcp/config';
import {
  __resetSessionsForTest,
  createSession,
  getSession,
  PREWARM_TTL_MS,
  retainSession,
} from '../claude-session-registry';
import * as wakeHold from '../claude-wake-hold';
import * as socketClient from '../client';
import { prewarmClaudeSession } from '../execution/claude-session/prewarm';
import { abortActiveExecutionsForSubChats } from '../executor';
import {
  _clearActiveExecutionsForTests,
  _registerExecutionForTests,
} from '../streaming/execution-registry';
import { answeringCli, replies } from './claude-warm-session';
import { mockQuery, never } from './claude-turn-abort';
import type { ExecutorPermissionHarness } from './executor-codex-permissions';

type PrewarmHarness = Pick<ExecutorPermissionHarness, 'basePayload' | 'handleRemoteExecute'> & {
  claudeQueryMock: ReturnType<typeof vi.fn>;
};
type Payload = Parameters<PrewarmHarness['handleRemoteExecute']>[0];

let payload: PrewarmHarness['basePayload'];
let chatRow: Record<string, unknown>;
let subChatSessionId: string | null;

const sessionLines = (kind: string, subChatId = payload.subChatId) =>
  vi
    .mocked(log.info)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith(`[Claude Session] ${kind} sub=${subChatId} `))
    .map((line) => line.slice(`[Claude Session] ${kind} sub=${subChatId} `.length));
const prewarm = (subChatId = payload.subChatId, mode?: ChatMode) =>
  prewarmClaudeSession({ chatId: payload.chatId, subChatId, mode });
/** A CLI that idles until closed, as a used session of another chat does. */
const parkedQuery = () => ({ next: never, close: vi.fn() }) as unknown as Query;
const STALE_RESUME = 'No conversation found with session ID: sess-held';
const failedResult = (subtype: string, ...errors: string[]) => ({
  type: 'result',
  subtype,
  is_error: true,
  errors,
});
/** A CLI whose `resume` id names no transcript. The one-shot SDK throws it; a live session instead
 * reports it as the failed result frame its turn ends on. */
const staleResumeCli = (afterPrompt: boolean, reported = false) =>
  async function* ({ prompt }: { prompt: AsyncIterator<SDKUserMessage> }) {
    if (afterPrompt) await prompt.next();
    if (reported) yield failedResult('error_during_execution', STALE_RESUME);
    else throw new Error(`Claude Code returned an error result: ${STALE_RESUME}`);
  };
/** Holds the pre-warm's sub-chat read until released, as a slow spec build does. */
function slowSubChatRead() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const row = { chatId: payload.chatId, sessionId: 'sess-held', mode: 'agent' };
  vi.mocked(getSubChatById).mockImplementationOnce(async () => {
    await gate;
    return row as never;
  });
  return release;
}
const linearMcp = async () => ({
  linear: { name: 'linear', type: 'cloud_api', authType: 'none', command: '', args: [], url: 'u' },
});

/** Registers the cases proving a chat's CLI can start when the chat opens: the send claims it
 * when nothing changed, spawns cold when something did, and idle pre-warms never pile up. */
export function registerClaudePrewarmTests(harness: PrewarmHarness): void {
  const { claudeQueryMock } = harness;
  const send = (message: string, overrides: Partial<Payload> = {}) =>
    harness.handleRemoteExecute({ ...payload, sessionId: 'sess-held', message, ...overrides });
  const spawnedResume = (call: number) =>
    (claudeQueryMock.mock.calls[call]?.[0] as { options: { resume?: string } }).options.resume;

  describe('pre-warmed Claude sessions', () => {
    beforeEach(() => {
      payload = { ...harness.basePayload, subChatId: randomUUID() };
      chatRow = {
        id: payload.chatId,
        projectId: payload.projectId,
        archivedAt: null,
        taskId: null,
      };
      subChatSessionId = 'sess-held';
      // SAFETY: the pre-warm and the send read only these fields of the chat row.
      vi.mocked(getChatWithProjectAccount).mockResolvedValue({
        chat: chatRow,
        account: { id: 'acc-1', label: null },
      } as never);
      // The chat's login resolves to the credential the executor suite serves by default.
      vi.mocked(getClaudeCodeTokenById).mockImplementation(() => getDefaultClaudeCodeToken());
      vi.mocked(getSubChatById).mockImplementation(
        async (_db, id) =>
          ({ id, chatId: payload.chatId, sessionId: subChatSessionId, mode: 'agent' }) as never,
      );
    });
    afterEach(() => {
      _clearActiveExecutionsForTests();
      __resetSessionsForTest();
      vi.mocked(getSubChatById).mockReset();
      vi.mocked(getClaudeCodeTokenById).mockReset();
      vi.useRealTimers();
    });
    registerHitAndMissTests(claudeQueryMock, send, spawnedResume);
    registerLifecycleTests(claudeQueryMock, send);
    registerSkipTests(claudeQueryMock, send);
  });
}

type Send = (message: string, overrides?: Partial<Payload>) => Promise<void>;

function registerHitAndMissTests(
  claudeQueryMock: PrewarmHarness['claudeQueryMock'],
  send: Send,
  spawnedResume: (call: number) => string | undefined,
): void {
  it('turn 1 runs on the pre-warmed CLI: one query, a prewarm claim hit, the message pushed once', async () => {
    // Read once by the pre-warm and once by the send.
    vi.mocked(getGlobalMcpServers)
      .mockImplementationOnce(linearMcp as never)
      .mockImplementationOnce(linearMcp as never);
    const prompts: SDKUserMessage[] = [];
    mockQuery(claudeQueryMock, answeringCli(prompts));

    expect(await prewarm()).toBe('spawned');
    expect(spawnedResume(0)).toBe('sess-held');
    expect(getSession(payload.subChatId)?.retained?.prewarm).toBe(true);
    // The staged MCP config is removed once the CLI has answered `initialize`.
    const staged = vi.mocked(fs.promises.writeFile).mock.calls.map(([file]) => `${file}`);
    const config = staged.find((file) => file.includes('mcp-config-'));
    await vi.waitFor(() => expect(fs.promises.rm).toHaveBeenCalledWith(config, { force: true }));
    await send('first');

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(sessionLines('claim')).toEqual(['hit prewarm']);
    expect(prompts.map((prompt) => prompt.message.content)).toEqual(['first']);
    expect(replies()).toEqual(['reply 1']);
    expect(getSession(payload.subChatId)?.retained?.prewarm).toBe(false);
    expect(sessionLines('prewarm')).toEqual(['outcome=spawned']);
  });

  it('a new chat’s pre-warm starts without resume and serves its first send', async () => {
    subChatSessionId = null;
    mockQuery(claudeQueryMock, answeringCli());

    await prewarm();
    await send('first', { sessionId: undefined });

    expect(spawnedResume(0)).toBeUndefined();
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(sessionLines('claim')).toEqual(['hit prewarm']);
  });

  it('with Auto Mode on, the pre-warm spawns what the send asks for and the send claims it', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    const settings = { autoReviewTools: true };

    await prewarmClaudeSession({ chatId: payload.chatId, subChatId: payload.subChatId, settings });
    await send('first', { settings });

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(sessionLines('claim')).toEqual(['hit prewarm']);
  });

  it('a send whose model changed since the pre-warm claims it and sets the model live', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());

    await prewarm();
    await send('first', { settings: { model: 'opus' } });

    expect(sessionLines('claim')).toEqual(['hit prewarm']);
    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    expect(warm.setModel).toHaveBeenLastCalledWith(expect.stringContaining('opus'));
  });

  it('a send whose settings changed since the pre-warm retires it and spawns cold, resuming', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());

    await prewarm();
    await send('first', { settings: { effort: 'max' } });

    expect(sessionLines('claim')).toEqual(['miss:key-mismatch:effort prewarm']);
    expect(sessionLines('retire')).toEqual(['reason=key-mismatch:effort prewarm']);
    expect(warm.close).toHaveBeenCalledOnce();
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(spawnedResume(1)).toBe('sess-held');
    expect(replies()).toEqual(['reply 1']);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a claimed pre-warm whose resume is stale falls back like a cold send: fresh, no resume', async () => {
    mockQuery(claudeQueryMock, staleResumeCli(true));
    mockQuery(claudeQueryMock, staleResumeCli(false));
    mockQuery(claudeQueryMock, answeringCli());

    await prewarm();
    await send('first');

    expect(sessionLines('claim')).toEqual(['hit prewarm', 'miss:none', 'miss:none']);
    expect([0, 1, 2].map(spawnedResume)).toEqual(['sess-held', 'sess-held', undefined]);
    expect(replies()).toEqual(['reply 1']);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it.each([
    ['a claimed pre-warm', true],
    ['a cold send', false],
  ])('%s whose stale resume ends the turn on a failed result reruns fresh', async (_, warmed) => {
    mockQuery(claudeQueryMock, staleResumeCli(true, true));
    mockQuery(claudeQueryMock, answeringCli());

    if (warmed) await prewarm();
    await send('first');

    expect([0, 1].map(spawnedResume)).toEqual(['sess-held', undefined]);
    expect(replies()).toEqual(['reply 1']);
    expect(socketClient.sendErrorDirect).not.toHaveBeenCalled();
  });

  it('a turn that ends on any other failed result reports the failure, not a silent finish', async () => {
    mockQuery(claudeQueryMock, async function* ({ prompt }: { prompt: AsyncIterator<unknown> }) {
      await prompt.next();
      yield failedResult('error_max_turns');
    });

    await send('first');

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(socketClient.sendErrorDirect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error: 'Claude execution failed. Please try again.' }),
    );
  });
}

function registerLifecycleTests(claudeQueryMock: PrewarmHarness['claudeQueryMock'], send: Send) {
  it('an unclaimed pre-warm is closed when its TTL runs out, leaving nothing registered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warm = mockQuery(claudeQueryMock, answeringCli());
    await prewarm();

    vi.advanceTimersByTime(PREWARM_TTL_MS - 1);
    expect(warm.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(warm.close).toHaveBeenCalledOnce();
    expect(getSession(payload.subChatId)).toBeUndefined();
    expect(sessionLines('retire')).toEqual(['reason=idle-ttl prewarm']);
  });

  it('browsing six chats keeps only the two newest pre-warms, and evicts no used session', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    await send('first');
    const used = getSession(payload.subChatId);
    const chats = Array.from({ length: 6 }, () => randomUUID());
    const warms = chats.map(() => mockQuery(claudeQueryMock, answeringCli()));

    for (const id of chats) await prewarm(id);

    expect(claudeQueryMock).toHaveBeenCalledTimes(7);
    expect(chats.filter((id) => getSession(id)?.retained)).toEqual(chats.slice(4));
    for (const warm of warms.slice(0, 4)) expect(warm.close).toHaveBeenCalledOnce();
    expect(getSession(payload.subChatId)).toBe(used);
    expect(used?.retained?.prewarm).toBe(false);
  });

  it('switching back and forth between two chats starts each CLI once and keeps both', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const warms = [a, b].map(() => mockQuery(claudeQueryMock, answeringCli()));

    for (const id of [a, b, a, b]) await prewarm(id);

    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    for (const warm of warms) expect(warm.close).not.toHaveBeenCalled();
    expect(sessionLines('prewarm', a)).toEqual(['outcome=spawned', 'outcome=skipped:session']);
  });

  it('of the chats opened while one pre-warms, the last one warms once it lands', async () => {
    const chats = [randomUUID(), randomUUID(), randomUUID()];
    mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());

    const outcomes = await Promise.all(chats.map((id) => prewarm(id)));

    expect(outcomes).toEqual(['spawned', 'skipped:in-flight', 'skipped:in-flight']);
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(chats.map((id) => getSession(id)?.retained?.prewarm)).toEqual([true, undefined, true]);
    expect(sessionLines('prewarm', chats[2])).toEqual([
      'outcome=skipped:in-flight',
      'outcome=spawned',
    ]);
  });

  it('a chat warm or warming never displaces the chat queued behind the pre-warm in flight', async () => {
    const [warm, queued] = [randomUUID(), randomUUID()];
    for (let spawns = 0; spawns < 3; spawns += 1) mockQuery(claudeQueryMock, answeringCli());
    await prewarm(warm);
    const release = slowSubChatRead();

    const warming = prewarm();
    expect(await prewarm(queued)).toBe('skipped:in-flight');
    expect(await prewarm()).toBe('skipped:session');
    expect(await prewarm(warm)).toBe('skipped:session');
    release();

    expect(await warming).toBe('spawned');
    expect(claudeQueryMock).toHaveBeenCalledTimes(3);
    expect(getSession(queued)?.retained?.prewarm).toBe(true);
  });

  it('holds the app’s one pre-warm until its MCP servers connect, while a send claims it at once', async () => {
    const other = randomUUID();
    const warm = mockQuery(claudeQueryMock, answeringCli());
    mockQuery(claudeQueryMock, answeringCli());
    let connected = () => {};
    warm.mcpServerStatus.mockResolvedValueOnce([{ name: 'linear', status: 'pending' }]);
    warm.mcpServerStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        connected = () => resolve([{ name: 'linear', status: 'connected' }]);
      }),
    );

    const warming = prewarm();
    await vi.waitFor(() => expect(warm.mcpServerStatus).toHaveBeenCalledTimes(2));
    expect(await prewarm(other)).toBe('skipped:in-flight');
    await send('first');
    expect(sessionLines('claim')).toEqual(['hit prewarm']);
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    connected();

    expect(await warming).toBe('spawned');
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(getSession(other)?.retained?.prewarm).toBe(true);
  });

  it('after the app-quit sweep no pre-warm starts: the one in flight is retired, the queued dropped', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());
    const release = slowSubChatRead();
    const [queued, late] = [randomUUID(), randomUUID()];

    const warming = prewarm();
    expect(await prewarm(queued)).toBe('skipped:in-flight');
    wakeHold.releaseNonFlowClaudeSessions('app-quit');
    release();

    expect(await warming).toBe('spawned');
    expect(warm.close).toHaveBeenCalledOnce();
    expect(sessionLines('prewarm', queued)).toEqual([
      'outcome=skipped:in-flight',
      'outcome=skipped:quitting',
    ]);
    expect(await prewarm(late)).toBe('skipped:quitting');
    expect(claudeQueryMock).toHaveBeenCalledOnce();
  });

  it('a chat deleted while its pre-warm waits behind another is never warmed', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    const release = slowSubChatRead();
    const queued = randomUUID();

    const warming = prewarm();
    expect(await prewarm(queued)).toBe('skipped:in-flight');
    abortActiveExecutionsForSubChats([queued], 'chat deleted');
    release();

    expect(await warming).toBe('spawned');
    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(sessionLines('prewarm', queued)).toEqual(['outcome=skipped:in-flight']);
  });

  it('a chat deleted while its pre-warm spawns is left no CLI', async () => {
    const warm = mockQuery(claudeQueryMock, answeringCli());
    const release = slowSubChatRead();

    const warming = prewarm();
    abortActiveExecutionsForSubChats([payload.subChatId], 'chat deleted');
    release();

    expect(await warming).toBe('spawned');
    expect(warm.close).toHaveBeenCalledOnce();
    expect(getSession(payload.subChatId)).toBeUndefined();
    expect(sessionLines('retire')).toEqual(['reason=chat deleted']);
  });

  it('a send while its chat pre-warms waits for it and claims it: one CLI', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    const release = slowSubChatRead();

    const warming = prewarm();
    const sending = send('first');
    // The send has built its spec (the pre-warm has not): its claim now waits for the pre-warm.
    const specs = () => vi.mocked(log.info).mock.calls.filter(([line]) => /SDK call/.test(line));
    await vi.waitFor(() => expect(specs()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionLines('claim')).toEqual([]);
    expect(claudeQueryMock).not.toHaveBeenCalled();
    release();
    await Promise.all([warming, sending]);

    expect(claudeQueryMock).toHaveBeenCalledOnce();
    expect(sessionLines('claim')).toEqual(['hit prewarm']);
    expect(replies()).toEqual(['reply 1']);
  });
}

function registerSkipTests(claudeQueryMock: PrewarmHarness['claudeQueryMock'], send: Send): void {
  const credential = { token: 'k', isApiKey: true, label: 'c' };
  it.each<[string, () => unknown, ChatMode?]>([
    ['debug', () => {}, 'debug'],
    [
      'active-execution',
      () => _registerExecutionForTests(payload.subChatId, new AbortController()),
    ],
    ['held', () => vi.spyOn(wakeHold, 'hasWakeHold').mockReturnValueOnce(true)],
    ['closed', () => Object.assign(chatRow, { archivedAt: new Date() })],
    ['task-linked', () => Object.assign(chatRow, { taskId: 'task-1' })],
    [
      'task-linked',
      () => vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({ id: 't' } as never),
    ],
    [
      'not-claude',
      () =>
        vi.mocked(getClaudeCodeTokenById).mockResolvedValueOnce({ ...credential, type: 'codex' }),
    ],
    [
      'login-removed',
      () =>
        vi
          .mocked(getChatWithProjectAccount)
          .mockResolvedValueOnce({ chat: chatRow, account: null } as never),
    ],
    [
      'cap-full',
      () => {
        for (const id of ['u1', 'u2', 'u3', 'u4']) retainSession(createSession(id, parkedQuery));
      },
    ],
  ])('skips a pre-warm: %s', async (reason, arrange, mode) => {
    arrange();

    expect(await prewarm(payload.subChatId, mode)).toBe(`skipped:${reason}`);

    expect(claudeQueryMock).not.toHaveBeenCalled();
    expect(sessionLines('prewarm')).toEqual([`outcome=skipped:${reason}`]);
  });

  it('skips a chat whose CLI is already up, and an id unfit for session paths', async () => {
    mockQuery(claudeQueryMock, answeringCli());
    await send('first');

    expect(await prewarm()).toBe('skipped:session');
    expect(await prewarm('../escape')).toBe('skipped:invalid-id');
    expect(claudeQueryMock).toHaveBeenCalledOnce();
  });
}
