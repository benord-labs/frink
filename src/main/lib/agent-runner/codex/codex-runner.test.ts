/**
 * runCodexAgent unit tests. The app-server registry + binary resolver are mocked
 * (no real codex process); the pure codex-events mapping runs for real so the
 * notification→chunk + approval→decision wiring is exercised end-to-end against a
 * fake JSON-RPC client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import {
  _resetProviderTopologyForTests,
  getRuntimeTopologySnapshot,
} from '../../diagnostics/provider-topology';
import { COMMAND_APPROVAL_METHOD, FILE_CHANGE_APPROVAL_METHOD } from './codex-events';
import {
  codexHostPermissionDeduper,
  FRINK_HOST_TOOL_PERMISSION_METHOD,
  parseFrinkHostToolPermissionRequest,
} from './codex-host-permissions';
import { getCodexLiveTurn } from './codex-live-turn';

vi.mock('./codex-binary', () => ({
  resolveCodexBinary: vi.fn(() => '/usr/bin/codex'),
  getCodexCliMissingMessage: vi.fn(() => 'install codex'),
}));
vi.mock('./app-server-registry', () => ({
  getCodexAppServer: vi.fn(),
  disposeCodexAppServerSession: vi.fn(),
}));

import { disposeCodexAppServerSession, getCodexAppServer } from './app-server-registry';
import { resolveCodexBinary } from './codex-binary';
import {
  CODEX_APPROVAL_POLICY,
  CODEX_AUTO_REVIEWER,
  CODEX_SANDBOX_MODE,
  CODEX_USER_REVIEWER,
  isRecoverableCodexThreadResumeError,
  runCodexAgent,
} from './codex-runner';

type FakeResponse = unknown | ((params: unknown) => unknown);

/**
 * Fake CodexAppServerClient that mirrors the real threadId-demux surface: turns
 * register via `forThread(threadId)`, close/error stay connection-level. Handlers
 * are grouped by threadId so a concurrent-turn test can drive each thread in
 * isolation; single-turn tests use the threadId-agnostic `fire`/`invokeRequest`.
 */
function makeFakeClient(responses: Record<string, FakeResponse> = {}) {
  type Sub = {
    notif: Map<string, (p: unknown) => void>;
    req: Map<string, (p: unknown) => unknown | Promise<unknown>>;
  };
  const subs = new Map<string, Set<Sub>>();
  const allSubs = () => [...subs.values()].flatMap((set) => [...set]);
  const closeHandlers = new Set<() => void>();
  const errorHandlers = new Set<(e: unknown) => void>();
  const sent: Array<{ method: string; params: unknown }> = [];
  return {
    sent,
    /** Fire a notification to every live subscription (single-turn convenience). */
    fire: (method: string, params: unknown) => {
      for (const s of allSubs()) s.notif.get(method)?.(params);
    },
    /** Fire a notification only to subscriptions on `threadId` (concurrent-turn isolation). */
    fireTo: (threadId: string, method: string, params: unknown) => {
      for (const s of subs.get(threadId) ?? []) s.notif.get(method)?.(params);
    },
    fireClose: () => {
      for (const h of closeHandlers) h();
    },
    fireError: (e: unknown) => {
      for (const h of errorHandlers) h(e);
    },
    invokeRequest: (method: string, params: unknown) =>
      allSubs()
        .find((s) => s.req.has(method))
        ?.req.get(method)?.(params),
    invokeRequestTo: (threadId: string, method: string, params: unknown) =>
      [...(subs.get(threadId) ?? [])].find((s) => s.req.has(method))?.req.get(method)?.(params),
    client: {
      forThread: (threadId: string) => {
        const sub: Sub = { notif: new Map(), req: new Map() };
        let set = subs.get(threadId);
        if (!set) {
          set = new Set();
          subs.set(threadId, set);
        }
        set.add(sub);
        return {
          onNotification: (m: string, h: (p: unknown) => void) => {
            sub.notif.set(m, h);
            return { dispose: () => sub.notif.delete(m) };
          },
          onRequest: (m: string, h: (p: unknown) => unknown) => {
            sub.req.set(m, h);
            return { dispose: () => sub.req.delete(m) };
          },
          expectTurnStart: () => {},
          bindTurn: () => {},
          dispose: () => set.delete(sub),
        };
      },
      onClose: (h: () => void) => {
        closeHandlers.add(h);
        return { dispose: () => closeHandlers.delete(h) };
      },
      onError: (h: (e: unknown) => void) => {
        errorHandlers.add(h);
        return { dispose: () => errorHandlers.delete(h) };
      },
      sendRequest: (method: string, params?: unknown) => {
        sent.push({ method, params });
        const r = responses[method];
        return Promise.resolve(typeof r === 'function' ? r(params) : (r ?? {}));
      },
    },
  };
}

function params(over: Partial<Parameters<typeof runCodexAgent>[0]> = {}) {
  return {
    prompt: 'do it',
    cwd: '/repo',
    credentialId: 'codex-default',
    env: {},
    abortController: new AbortController(),
    checkApproval: vi.fn(async () => ({ allowed: true as const })),
    ...over,
  };
}

/** Pull the generator to completion, returning every yielded chunk. */
async function drain(gen: AsyncGenerator<UIMessageChunk, void>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for (let r = await gen.next(); !r.done; r = await gen.next()) out.push(r.value);
  return out;
}

/** Fake client pre-loaded with the standard thread/start + turn/start responses, wired into the registry mock. */
function startedFakeClient(): ReturnType<typeof makeFakeClient> {
  const fake = makeFakeClient({
    'thread/start': { thread: { id: 'th1' } },
    'turn/start': { turn: { id: 'tn1' } },
  });
  vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
  return fake;
}

function rememberHostPermissionForStartedTurn(): void {
  const request = parseFrinkHostToolPermissionRequest({
    protocolVersion: 1,
    threadId: 'th1',
    turnId: 'tn1',
    itemId: 'item-cleanup',
    kind: 'mcp',
    toolName: 'mcp__frink_dynamic_chat__frink_flows_patch',
    input: { flowId: 'flow-1' },
    mcp: { server: 'frink_dynamic_chat', tool: 'frink_flows_patch' },
  });
  if (!request) throw new Error('host permission fixture must parse');
  codexHostPermissionDeduper.remember(request);
}

function hasStartedTurnMcpPermission(): boolean {
  return codexHostPermissionDeduper.consumeMcp(
    'th1',
    'tn1',
    'item-cleanup',
    'frink_dynamic_chat',
    'frink_flows_patch',
    { flowId: 'flow-1' },
  );
}

/** Drive one full turn against `fake` to completion and return the JSON-RPC requests it recorded. */
async function sentForTurn(
  fake: ReturnType<typeof makeFakeClient>,
  over: Partial<Parameters<typeof runCodexAgent>[0]>,
): Promise<Array<{ method: string; params: unknown }>> {
  vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
  const gen = runCodexAgent(params(over));
  await gen.next();
  await gen.next();
  fake.fire('turn/completed', { turn: { status: 'completed' } });
  for (let r = await gen.next(); !r.done; r = await gen.next());
  return fake.sent;
}

async function primeThread(fake: ReturnType<typeof makeFakeClient>): Promise<void> {
  await sentForTurn(fake, {});
  fake.sent.length = 0;
}

/**
 * Drive a turn to "handlers registered", run `afterReady` (fire events / invoke
 * requests), then complete the turn and return its result + every yielded chunk.
 * The shared scaffold for the streaming + file-change approval tests.
 */
async function withTurn<T>(
  over: Partial<Parameters<typeof runCodexAgent>[0]>,
  afterReady: (fake: ReturnType<typeof makeFakeClient>) => Promise<T> | T,
): Promise<{ result: T; chunks: UIMessageChunk[] }> {
  const fake = startedFakeClient();
  const gen = runCodexAgent(params(over));
  await gen.next(); // start
  await gen.next(); // message-metadata — handlers registered, parked on the queue
  const result = await afterReady(fake);
  fake.fire('turn/completed', { turn: { status: 'completed' } });
  const chunks: UIMessageChunk[] = [];
  for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);
  return { result, chunks };
}

/** Fire a sequence of [itemId, delta] notifications of one method under backpressure; return all chunks. */
async function deltaStream(
  method: string,
  fires: Array<[string, string]>,
): Promise<UIMessageChunk[]> {
  const { chunks } = await withTurn({}, (fake) => {
    for (const [itemId, delta] of fires) fake.fire(method, { itemId, delta });
  });
  return chunks;
}

/**
 * Start two concurrent turns against ONE shared client (distinct thread/turn ids),
 * each parked on its queue. The shared scaffold for the concurrency-isolation tests.
 */
async function twoConcurrentTurns(
  overA: Partial<Parameters<typeof runCodexAgent>[0]> = {},
  overB: Partial<Parameters<typeof runCodexAgent>[0]> = {},
) {
  let n = 0;
  const fake = makeFakeClient({
    'thread/start': () => ({ thread: { id: `th${++n}` } }),
    'turn/start': () => ({ turn: { id: `tn${n}` } }),
  });
  vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
  const acA = new AbortController();
  const acB = new AbortController();
  const a = runCodexAgent(params({ abortController: acA, ...overA }));
  await a.next();
  await a.next(); // th1/tn1, parked
  const b = runCodexAgent(params({ abortController: acB, ...overB }));
  await b.next();
  await b.next(); // th2/tn2, parked
  return { fake, a, b, acA, acB };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetProviderTopologyForTests();
  codexHostPermissionDeduper.clearTurn('th1', 'tn1');
  vi.mocked(resolveCodexBinary).mockReturnValue('/usr/bin/codex');
});
afterEach(() => vi.restoreAllMocks());

describe('runCodexAgent', () => {
  it('yields a binary-missing error when codex is not installed', async () => {
    vi.mocked(resolveCodexBinary).mockReturnValue(null);
    const chunks = await drain(runCodexAgent(params()));
    expect(chunks).toEqual([{ type: 'error', errorText: 'install codex' }, { type: 'finish' }]);
    expect(getCodexAppServer).not.toHaveBeenCalled();
  });

  it('starts a thread with the host-ask approval policy + workspace sandbox, then streams text', async () => {
    const fake = startedFakeClient();

    const gen = runCodexAgent(params());
    expect((await gen.next()).value).toEqual({ type: 'start' });
    // Next pull runs the async setup (thread/start + turn/start) and yields the session id.
    expect((await gen.next()).value).toMatchObject({
      type: 'message-metadata',
      messageMetadata: { sessionId: 'th1' },
    });
    expect(getRuntimeTopologySnapshot().codexTurnStartsTotal).toBe(1);

    // Handlers are registered now — drive a streamed answer + completion.
    fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'hello' });
    fake.fire('turn/completed', { turn: { status: 'completed' } });

    const rest: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) rest.push(r.value);

    const threadStart = fake.sent.find((s) => s.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: '/repo',
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      approvalsReviewer: CODEX_USER_REVIEWER,
      config: {
        mcp_oauth_credentials_store: 'file',
        mcp_servers: {},
      },
    });
    expect(CODEX_APPROVAL_POLICY).toBe('on-request');
    expect(CODEX_SANDBOX_MODE).toBe('workspace-write');
    expect(fake.sent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      threadId: 'th1',
      input: [{ type: 'text', text: 'do it' }],
      approvalsReviewer: CODEX_USER_REVIEWER,
    });
    expect(rest).toContainEqual({ type: 'text-start', id: 'i1' });
    expect(rest).toContainEqual({ type: 'text-delta', id: 'i1', delta: 'hello' });
    expect(rest).toContainEqual({ type: 'text-end', id: 'i1' });
    expect(rest.some((c) => c.type === 'finish')).toBe(true);
  });

  /**
   * The AI SDK holds one active text part per id and throws on a `text-end` it has no
   * `text-start` for — which a re-close and a never-opened block both look like. codex-events
   * closes the block on item/completed and the runner's end-of-turn sweep closes what is left
   * open, so these assert the two writers never both close the same block (and never close one
   * that was never opened). Counted, not `toContainEqual`: a duplicate satisfies membership.
   */
  it('closes a completed agent message exactly once (provider close, then a silent sweep)', async () => {
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'hello' });
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
    });

    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([{ type: 'text-end', id: 'i1' }]);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
  });

  it('drops a close for a text block that never opened (item completed with no deltas)', async () => {
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i9' } });
    });

    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([]);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
  });

  it('closes a block the provider left open when the turn aborts mid-text (sweep still fires)', async () => {
    const fake = startedFakeClient();
    const abortController = new AbortController();
    const gen = runCodexAgent(params({ abortController }));
    await gen.next(); // start
    await gen.next(); // message-metadata — handlers registered

    fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'partial' });
    const chunks: UIMessageChunk[] = [];
    // Pull the queued text chunks, then abort before any item/completed arrives.
    chunks.push((await gen.next()).value as UIMessageChunk);
    abortController.abort();
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);

    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([{ type: 'text-end', id: 'i1' }]);
  });

  it('brackets two text blocks in one turn independently (provider closes them out of order)', async () => {
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'first' });
      fake.fire('item/agentMessage/delta', { itemId: 'i2', delta: 'second' });
      // Closed newest-first: a turn that speaks, runs a tool, then finishes the earlier message.
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i2' } });
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
    });

    expect(chunks.filter((c) => c.type === 'text-start')).toEqual([
      { type: 'text-start', id: 'i1' },
      { type: 'text-start', id: 'i2' },
    ]);
    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([
      { type: 'text-end', id: 'i2' },
      { type: 'text-end', id: 'i1' },
    ]);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
  });

  it('drops a repeated close for the same block (provider replays item/completed)', async () => {
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'hello' });
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
    });

    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([{ type: 'text-end', id: 'i1' }]);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
  });

  it('sweeps only the block left open when a turn aborts with another already closed', async () => {
    const fake = startedFakeClient();
    const abortController = new AbortController();
    const gen = runCodexAgent(params({ abortController }));
    await gen.next(); // start
    await gen.next(); // message-metadata — handlers registered

    const chunks: UIMessageChunk[] = [];
    fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'done' });
    fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
    // Drain the finished block first: an abort discards whatever is still queued, so its
    // close has to be delivered before the second block opens for this to assert anything.
    for (let i = 0; i < 3; i += 1) chunks.push((await gen.next()).value as UIMessageChunk);

    fake.fire('item/agentMessage/delta', { itemId: 'i2', delta: 'still going' });
    chunks.push((await gen.next()).value as UIMessageChunk);
    abortController.abort();
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);

    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([
      { type: 'text-end', id: 'i1' }, // provider close, forwarded once
      { type: 'text-end', id: 'i2' }, // sweep close, the block still open at abort
    ]);
  });

  it('closes an open Thinking card even when the close that flushed it is dropped', async () => {
    // Pins the gate BELOW the thinking flush: a dropped close must still end the card, or a
    // turn whose last text block never opened would leave "Thinking" spinning forever.
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/reasoning/textDelta', { itemId: 'r1', delta: 'mulling it over' });
      fake.fire('item/completed', { item: { type: 'agentMessage', id: 'i1' } });
    });

    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
    expect(chunks.filter((c) => c.type === 'text-end')).toEqual([]);
  });

  it('two concurrent turns closing the same itemId keep their own bracket state', async () => {
    // Split view on one conversation: both turns stream an item under the same id, and neither
    // turn's close may consume the other's open block.
    const { fake, a, b } = await twoConcurrentTurns();

    fake.fireTo('th1', 'item/agentMessage/delta', { itemId: 'i', delta: 'A' });
    fake.fireTo('th2', 'item/agentMessage/delta', { itemId: 'i', delta: 'B' });
    fake.fireTo('th1', 'item/completed', { item: { type: 'agentMessage', id: 'i' } });
    fake.fireTo('th2', 'item/completed', { item: { type: 'agentMessage', id: 'i' } });
    fake.fireTo('th1', 'turn/completed', { turn: { status: 'completed' } });
    fake.fireTo('th2', 'turn/completed', { turn: { status: 'completed' } });

    const textEnds = async (gen: AsyncGenerator<UIMessageChunk, void>) => {
      const out: UIMessageChunk[] = [];
      for (let r = await gen.next(); !r.done; r = await gen.next()) {
        if (r.value.type === 'text-end') out.push(r.value);
      }
      return out;
    };
    expect(await textEnds(a)).toEqual([{ type: 'text-end', id: 'i' }]);
    expect(await textEnds(b)).toEqual([{ type: 'text-end', id: 'i' }]);
  });

  it("starts every thread ephemeral so it never lands in the user's Codex history", async () => {
    const sent = await sentForTurn(startedFakeClient(), {});
    expect(sent.find((s) => s.method === 'thread/start')?.params).toMatchObject({
      ephemeral: true,
    });
  });

  it('continues a live thread with turn/start directly, never thread/resume', async () => {
    let turnNumber = 0;
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'prev-thread' } },
      'turn/start': () => ({ turn: { id: `tn${++turnNumber}` } }),
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
    await primeThread(fake);

    const gen = runCodexAgent(
      params({
        prompt: 'resume prompt',
        freshThreadFallbackPrompt: 'fresh fallback prompt',
        resumeThreadId: 'prev-thread',
      }),
    );
    await gen.next(); // start
    expect((await gen.next()).value).toMatchObject({
      messageMetadata: { sessionId: 'prev-thread' },
    });
    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());

    // An ephemeral thread has no rollout: thread/resume on it fails with "no rollout found".
    expect(fake.sent.map((s) => s.method)).toEqual(['turn/start']);
    expect(fake.sent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      threadId: 'prev-thread',
      input: [{ type: 'text', text: 'resume prompt' }],
      approvalsReviewer: CODEX_USER_REVIEWER,
    });
  });

  it('starts fresh with chat history when the stored thread belongs to another app-server', async () => {
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'fresh-thread' } },
      'turn/start': { turn: { id: 'fresh-turn' } },
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);

    const gen = runCodexAgent(
      params({
        prompt: 'latest message only',
        freshThreadFallbackPrompt: 'existing chat history plus latest message',
        resumeThreadId: 'thread-from-old-process',
      }),
    );
    await gen.next();
    expect((await gen.next()).value).toMatchObject({
      messageMetadata: { sessionId: 'fresh-thread' },
    });
    fake.fire('turn/completed', { turn: { status: 'completed' } });
    await drain(gen);

    expect(fake.sent.map((sent) => sent.method)).toEqual(['thread/start', 'turn/start']);
    expect(fake.sent.find((sent) => sent.method === 'turn/start')?.params).toMatchObject({
      threadId: 'fresh-thread',
      input: [{ type: 'text', text: 'existing chat history plus latest message' }],
    });
  });

  it('scopes canonical MCP secrets to request config, not the app-server env or argv', async () => {
    const fake = startedFakeClient();
    const gen = runCodexAgent(
      params({
        canonicalMcpServers: {
          shortcut: {
            type: 'http',
            url: 'https://mcp.example.test',
            _oauth: { accessToken: 'frink-secret' },
          },
        },
      }),
    );
    await gen.next();
    await gen.next();
    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());

    const appServerCall = vi.mocked(getCodexAppServer).mock.calls[0];
    const options = appServerCall?.[2] as { args: string[]; env: Record<string, string> };
    const requestConfig = (
      fake.sent.find((sent) => sent.method === 'thread/start')?.params as {
        config: {
          mcp_servers: Record<string, { http_headers: Record<string, string> }>;
        };
      }
    ).config;
    expect(requestConfig.mcp_servers.shortcut.http_headers).toEqual({
      Authorization: 'Bearer frink-secret',
    });
    expect(Object.values(options.env)).not.toContain('frink-secret');
    expect(options.args.join(' ')).not.toContain('frink-secret');
    // configRevision = mcp-binding sha + vendor-skill-roots sha (sc-1731).
    expect(appServerCall?.[4]).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/);
  });

  it('recovers a vanished live thread by starting fresh with the fallback prompt', async () => {
    let startedThread = 'missing-thread';
    const fake = makeFakeClient({
      'thread/start': () => ({ thread: { id: startedThread } }),
      'turn/start': (p: unknown) => {
        const { threadId } = p as { threadId: string };
        if (startedThread === 'fresh-thread' && threadId === 'missing-thread') {
          throw new Error('thread not found: missing-thread');
        }
        return { turn: { id: 'fresh-turn' } };
      },
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
    await primeThread(fake);
    startedThread = 'fresh-thread';

    const gen = runCodexAgent(
      params({
        prompt: 'resume prompt',
        freshThreadFallbackPrompt: 'fresh prompt with history',
        resumeThreadId: 'missing-thread',
      }),
    );
    await gen.next(); // start
    expect((await gen.next()).value).toMatchObject({
      messageMetadata: { sessionId: 'fresh-thread' },
    });
    fake.fireTo('fresh-thread', 'turn/completed', { turn: { status: 'completed' } });
    const chunks: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);

    expect(fake.sent.map((sent) => sent.method)).toEqual([
      'turn/start',
      'thread/start',
      'turn/start',
    ]);
    expect(fake.sent.at(-1)?.params).toMatchObject({
      threadId: 'fresh-thread',
      input: [{ type: 'text', text: 'fresh prompt with history' }],
    });
    expect(
      fake.invokeRequestTo('missing-thread', COMMAND_APPROVAL_METHOD, {
        id: 'stale-request',
      }),
    ).toBeUndefined();
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: { sessionId: 'fresh-thread' },
    });
  });

  it('propagates non-recoverable live-thread errors without starting a new thread', async () => {
    let primed = false;
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'private-thread' } },
      'turn/start': () => {
        if (primed) throw new Error('Permission denied');
        return { turn: { id: 'prime-turn' } };
      },
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
    await primeThread(fake);
    primed = true;

    const chunks = await drain(
      runCodexAgent(
        params({
          freshThreadFallbackPrompt: 'must not be used',
          resumeThreadId: 'private-thread',
        }),
      ),
    );

    expect(fake.sent.map((sent) => sent.method)).toEqual(['turn/start']);
    expect(chunks).toContainEqual({ type: 'error', errorText: 'Permission denied' });
    expect(chunks.at(-1)).toEqual({ type: 'finish', messageMetadata: undefined });
  });

  it('does not recover a missing thread after the turn is aborted', async () => {
    const abortController = new AbortController();
    let primed = false;
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'missing-thread' } },
      'turn/start': () => {
        if (!primed) return { turn: { id: 'prime-turn' } };
        abortController.abort();
        throw new Error('thread not found: missing-thread');
      },
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
    await primeThread(fake);
    primed = true;

    const chunks = await drain(
      runCodexAgent(
        params({
          abortController,
          freshThreadFallbackPrompt: 'must not be used',
          resumeThreadId: 'missing-thread',
        }),
      ),
    );

    expect(fake.sent.map((sent) => sent.method)).toEqual(['turn/start']);
    expect(chunks).toEqual([{ type: 'start' }, { type: 'finish', messageMetadata: undefined }]);
  });

  it('sends the Fast service tier on turn/start only, never on thread/start', async () => {
    const sent = await sentForTurn(startedFakeClient(), { serviceTier: 'priority' });
    expect(sent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'priority',
    });
    expect(sent.find((s) => s.method === 'thread/start')?.params).not.toHaveProperty('serviceTier');
  });

  it.each([
    ['explicitly off', { serviceTier: null as null }],
    ['omitted by the caller', {}],
  ])('sends an explicit null serviceTier when Fast is %s', async (_label, over) => {
    // The tier is thread-sticky (ThreadSettings.serviceTier persists, and the field applies to
    // "this turn and subsequent turns"), so an ABSENT key means "leave unchanged" — which would
    // keep billing the multiplier. Assert the key is present AND null, not merely falsy.
    const sent = await sentForTurn(startedFakeClient(), over);
    expect(sent.find((s) => s.method === 'turn/start')?.params).toHaveProperty('serviceTier', null);
  });

  it('clears the tier on the next turn of the same thread after Fast is switched off', async () => {
    // The regression this feature turns on: turn 1 buys the priority tier, turn 2 must actively
    // give it back. Resuming by thread id is also how a chat reopens after an app restart, so this
    // covers the restart path too.
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'sticky-thread' } },
      'turn/start': { turn: { id: 'tn1' } },
    });
    await sentForTurn(fake, { serviceTier: 'priority' });
    const turnOne = fake.sent.filter((s) => s.method === 'turn/start');
    expect(turnOne.at(-1)?.params).toMatchObject({ serviceTier: 'priority' });

    await sentForTurn(fake, {
      serviceTier: null,
      resumeThreadId: 'sticky-thread',
    });
    const turnTwo = fake.sent.filter((s) => s.method === 'turn/start');
    expect(turnTwo.at(-1)?.params).toHaveProperty('serviceTier', null);
    expect(fake.sent.map((s) => s.method)).not.toContain('thread/resume');
  });

  it('classifies only missing-thread resume failures as recoverable', () => {
    expect(isRecoverableCodexThreadResumeError(new Error('Unknown thread abc'))).toBe(true);
    expect(isRecoverableCodexThreadResumeError(new Error('Thread not found'))).toBe(true);
    expect(isRecoverableCodexThreadResumeError(new Error('Permission denied'))).toBe(false);
    expect(isRecoverableCodexThreadResumeError(new Error('Config file not found'))).toBe(false);
    expect(isRecoverableCodexThreadResumeError(new Error('Model does not exist'))).toBe(false);
  });

  it('uses Codex native auto review on thread and turn without changing the sandbox', async () => {
    const sent = await sentForTurn(startedFakeClient(), { autoReview: true });
    expect(sent.find((s) => s.method === 'thread/start')?.params).toMatchObject({
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX_MODE,
      approvalsReviewer: CODEX_AUTO_REVIEWER,
    });
    expect(sent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      approvalsReviewer: CODEX_AUTO_REVIEWER,
    });
  });

  it('resets a resumed thread to the explicit reviewer selected for this turn', async () => {
    const autoFake = makeFakeClient({
      'thread/start': { thread: { id: 'prev' } },
      'turn/start': { turn: { id: 'tn-auto' } },
    });
    await primeThread(autoFake);
    const autoSent = await sentForTurn(autoFake, { resumeThreadId: 'prev', autoReview: true });
    expect(autoSent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      approvalsReviewer: CODEX_AUTO_REVIEWER,
    });

    const manualFake = makeFakeClient({
      'thread/start': { thread: { id: 'prev' } },
      'turn/start': { turn: { id: 'tn-manual' } },
    });
    await primeThread(manualFake);
    const manualSent = await sentForTurn(manualFake, {
      resumeThreadId: 'prev',
      autoReview: false,
    });
    expect(manualSent.find((s) => s.method === 'turn/start')?.params).toMatchObject({
      approvalsReviewer: CODEX_USER_REVIEWER,
    });
  });

  it('isolates two concurrent turns on one shared client (no handler clobber)', async () => {
    // The core sc-952 regression: two turns in the same project+account share ONE
    // app-server client. Each must register under its own threadId so neither
    // clobbers the other — content streamed to one never reaches the other.
    let n = 0;
    const fake = makeFakeClient({
      'thread/start': () => ({ thread: { id: `th${++n}` } }),
      'turn/start': () => ({ turn: { id: `tn${n}` } }),
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);

    const a = runCodexAgent(params());
    await a.next(); // start
    await a.next(); // setup → th1/tn1, handlers registered, parked on the queue
    const b = runCodexAgent(params());
    await b.next();
    await b.next(); // th2/tn2

    fake.fireTo('th1', 'item/agentMessage/delta', { itemId: 'i', delta: 'A' });
    fake.fireTo('th2', 'item/agentMessage/delta', { itemId: 'i', delta: 'B' });
    fake.fireTo('th1', 'turn/completed', { turn: { status: 'completed' } });
    fake.fireTo('th2', 'turn/completed', { turn: { status: 'completed' } });

    const collect = async (gen: AsyncGenerator<UIMessageChunk, void>) => {
      const out: string[] = [];
      for (let r = await gen.next(); !r.done; r = await gen.next()) {
        if (r.value.type === 'text-delta') out.push(r.value.delta);
      }
      return out;
    };
    expect(await collect(a)).toEqual(['A']);
    expect(await collect(b)).toEqual(['B']);
  });

  it('a crash ends every concurrent turn (close fans out to all live turns)', async () => {
    // onClose stays connection-level (multi-listener) precisely so one crash ends
    // BOTH turns — not just the last to register (the demux only covers notif/request).
    const { fake, a, b } = await twoConcurrentTurns();
    fake.fireClose();
    const closed = {
      type: 'error',
      errorText: 'Codex app-server connection closed unexpectedly.',
    };
    expect(await drain(a)).toContainEqual(closed);
    expect(await drain(b)).toContainEqual(closed);
  });

  it('a transport error ends every concurrent turn on the shared client', async () => {
    // A broken pipe kills the client for every turn on it, not just the last to register.
    const { fake, a, b } = await twoConcurrentTurns();
    fake.fireError([new Error('write EPIPE'), undefined, undefined]);
    const isTransportError = (c: UIMessageChunk) =>
      c.type === 'error' && c.errorText.includes('transport error: write EPIPE');
    expect((await drain(a)).some(isTransportError)).toBe(true);
    expect((await drain(b)).some(isTransportError)).toBe(true);
  });

  it('aborting one turn interrupts only it and leaves the other streaming', async () => {
    const { fake, a, b, acA } = await twoConcurrentTurns();
    acA.abort();
    await drain(a); // A interrupts + finishes

    // B is untouched: still streams its own content and completes.
    fake.fireTo('th2', 'item/agentMessage/delta', { itemId: 'i', delta: 'B' });
    fake.fireTo('th2', 'turn/completed', { turn: { status: 'completed' } });
    const bChunks = await drain(b);

    // Exactly ONE interrupt, scoped to A's thread+turn — B was never interrupted.
    expect(fake.sent.filter((s) => s.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'th1', turnId: 'tn1' } },
    ]);
    expect(bChunks).toContainEqual({ type: 'text-delta', id: 'i', delta: 'B' });
  });

  it('concurrent turns gate fileChange approvals on their own cached paths (same itemId, no cache collision)', async () => {
    const gateA = vi.fn(async () => ({ allowed: true as const }));
    const gateB = vi.fn(async () => ({ allowed: true as const }));
    const { fake, a, b } = await twoConcurrentTurns(
      { checkApproval: gateA },
      { checkApproval: gateB },
    );

    // Both turns reuse itemId 'f1' but edit different files — the per-turn caches are
    // generator-local, so they must NOT collide across the shared client.
    fake.fireTo('th1', 'item/started', {
      item: { type: 'fileChange', id: 'f1', changes: [{ path: '/a.ts' }] },
    });
    fake.fireTo('th2', 'item/started', {
      item: { type: 'fileChange', id: 'f1', changes: [{ path: '/b.ts' }] },
    });
    await fake.invokeRequestTo('th1', FILE_CHANGE_APPROVAL_METHOD, {
      itemId: 'f1',
      grantRoot: '/',
    });
    await fake.invokeRequestTo('th2', FILE_CHANGE_APPROVAL_METHOD, {
      itemId: 'f1',
      grantRoot: '/',
    });

    expect(gateA).toHaveBeenCalledWith(expect.objectContaining({ input: { file_path: '/a.ts' } }));
    expect(gateB).toHaveBeenCalledWith(expect.objectContaining({ input: { file_path: '/b.ts' } }));
    expect(gateA).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: { file_path: '/b.ts' } }),
    );

    fake.fireTo('th1', 'turn/completed', { turn: { status: 'completed' } });
    fake.fireTo('th2', 'turn/completed', { turn: { status: 'completed' } });
    await drain(a);
    await drain(b);
  });

  it('sends model on thread/start + turn/start, but effort on turn/start ONLY (turn-scoped, v2)', async () => {
    const sent = await sentForTurn(startedFakeClient(), { model: 'gpt-5.3-codex', effort: 'high' });
    const threadStart = sent.find((s) => s.method === 'thread/start');
    const turnStart = sent.find((s) => s.method === 'turn/start');
    // ThreadStartParams carries model but has no effort field (serde would drop reasoning_effort).
    expect(threadStart?.params).toMatchObject({ model: 'gpt-5.3-codex' });
    expect(threadStart?.params).not.toHaveProperty('effort');
    // TurnStartParams carries both — effort is the camelCase v2 field, turn-scoped.
    expect(turnStart?.params).toMatchObject({ model: 'gpt-5.3-codex', effort: 'high' });
  });

  it('omits the effort field entirely when no effort is provided (app-server defaults to medium)', async () => {
    // Never send `effort: undefined` — serde would reject/null it; the key must be absent.
    const sent = await sentForTurn(startedFakeClient(), { model: 'gpt-5.3-codex' });
    expect(sent.find((s) => s.method === 'turn/start')?.params).not.toHaveProperty('effort');
  });

  it('on a live thread, sends model + effort on turn/start', async () => {
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'prev' } },
      'turn/start': { turn: { id: 'tn2' } },
    });
    await primeThread(fake);
    const sent = await sentForTurn(fake, {
      resumeThreadId: 'prev',
      model: 'gpt-5.2-codex',
      effort: 'low',
    });
    expect(sent.map((s) => s.method)).toEqual(['turn/start']);
    expect(sent[0]?.params).toMatchObject({ model: 'gpt-5.2-codex', effort: 'low' });
  });

  // The steer gate reads this signal to refuse a turn parked on a human decision. A command and a
  // file-change approval can be open at once, so the count must survive the first answer — and it
  // lives on THIS turn, so it can neither strand past teardown nor be read by a successor.
  it('reports an open approval until the last concurrent one is answered', async () => {
    const answer: Array<(v: { allowed: true }) => void> = [];
    const checkApproval = vi.fn(
      () => new Promise<{ allowed: true }>((resolve) => answer.push(resolve)),
    );

    await withTurn({ sessionKey: 's-appr', checkApproval }, async (fake) => {
      const first = fake.invokeRequest(COMMAND_APPROVAL_METHOD, { command: 'ls' });
      const second = fake.invokeRequest(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'f1' });
      await vi.waitFor(() => expect(answer).toHaveLength(2));
      expect(getCodexLiveTurn('s-appr')?.hasOpenApproval()).toBe(true);

      answer[0]({ allowed: true });
      await first;
      // Still parked: the second decision is outstanding.
      expect(getCodexLiveTurn('s-appr')?.hasOpenApproval()).toBe(true);

      answer[1]({ allowed: true });
      await second;
      expect(getCodexLiveTurn('s-appr')?.hasOpenApproval()).toBe(false);
    });
  });

  it('reports a downstream Frink permission wait as an open approval', async () => {
    let waiting = true;
    await withTurn({ sessionKey: 's-frink-permission', hasOpenPermission: () => waiting }, () => {
      expect(getCodexLiveTurn('s-frink-permission')?.hasOpenApproval()).toBe(true);
      waiting = false;
      expect(getCodexLiveTurn('s-frink-permission')?.hasOpenApproval()).toBe(false);
    });
  });

  it('routes an approval request through checkApproval and maps the decision', async () => {
    const fake = startedFakeClient();
    const checkApproval = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, message: 'blocked' });

    const gen = runCodexAgent(params({ checkApproval }));
    await gen.next();
    await gen.next(); // handlers registered

    const allow = await fake.invokeRequest(COMMAND_APPROVAL_METHOD, {
      command: 'ls',
      cwd: '/repo',
    });
    const deny = await fake.invokeRequest(COMMAND_APPROVAL_METHOD, { command: 'rm -rf /' });
    expect(allow).toEqual({ decision: 'accept' });
    expect(deny).toEqual({ decision: 'decline' });
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', input: { command: 'ls', cwd: '/repo' } }),
    );

    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());
  });

  it('returns host allow, defer, and deny without preapproving a deferred MCP call', async () => {
    const checkApproval = vi
      .fn()
      .mockResolvedValueOnce({ allowed: null })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, message: 'blocked' });
    const request = (itemId: string) => ({
      protocolVersion: 1,
      threadId: 'th1',
      turnId: 'tn1',
      itemId,
      kind: 'mcp',
      toolName: 'mcp__frink_dynamic_chat__frink_flows_patch',
      input: { flowId: 'flow-1' },
      mcp: { server: 'frink_dynamic_chat', tool: 'frink_flows_patch' },
    });

    const { result } = await withTurn({ checkApproval }, async (fake) => {
      const deferred = await fake.invokeRequest(
        FRINK_HOST_TOOL_PERMISSION_METHOD,
        request('item-defer'),
      );
      const allowed = await fake.invokeRequest(
        FRINK_HOST_TOOL_PERMISSION_METHOD,
        request('item-allow'),
      );
      const denied = await fake.invokeRequest(
        FRINK_HOST_TOOL_PERMISSION_METHOD,
        request('item-deny'),
      );
      const consume = (itemId: string) =>
        codexHostPermissionDeduper.consumeMcp(
          'th1',
          'tn1',
          itemId,
          'frink_dynamic_chat',
          'frink_flows_patch',
          { flowId: 'flow-1' },
        );
      return {
        deferred,
        allowed,
        denied,
        deferredPreapproved: consume('item-defer'),
        allowedPreapproved: consume('item-allow'),
        deniedPreapproved: consume('item-deny'),
      };
    });

    expect(result).toEqual({
      deferred: { decision: 'defer' },
      allowed: { decision: 'allow' },
      // sc-1357: the reason is Codex's model-visible text, so a timeout must not read as a refusal.
      denied: { decision: 'deny', reason: 'blocked' },
      deferredPreapproved: false,
      allowedPreapproved: true,
      deniedPreapproved: false,
    });
  });

  it('treats custom-node registration as transport-only without caching semantic consent', async () => {
    const checkApproval = vi.fn().mockResolvedValue({ allowed: false, message: 'blocked' });
    const request = {
      protocolVersion: 1,
      threadId: 'th-register',
      turnId: 'tn-register',
      itemId: 'item-register',
      kind: 'mcp',
      toolName: 'mcp__frink_dynamic_chat__frink_register_node',
      input: { packagePath: 'examples/custom-nodes/read-colocated-image' },
      mcp: { server: 'frink_dynamic_chat', tool: 'frink_register_node' },
    };

    const { result } = await withTurn({ checkApproval }, async (fake) => {
      const decision = await fake.invokeRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, request);
      const cached = codexHostPermissionDeduper.consumeMcp(
        'th-register',
        'tn-register',
        'item-register',
        'frink_dynamic_chat',
        'frink_register_node',
        request.input,
      );
      return { decision, cached };
    });

    expect(result).toEqual({ decision: { decision: 'allow' }, cached: false });
    expect(checkApproval).not.toHaveBeenCalled();
  });

  it('gates a file-change approval on the real per-file paths cached from item/started', async () => {
    const checkApproval = vi.fn(async () => ({ allowed: true as const }));
    const { result: decision } = await withTurn({ checkApproval }, (fake) => {
      // The fileChange item arrives first, carrying the real paths; the approval
      // request that follows carries only itemId + grantRoot.
      fake.fire('item/started', {
        item: {
          type: 'fileChange',
          id: 'f1',
          changes: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
        },
      });
      return fake.invokeRequest(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'f1', grantRoot: '/repo' });
    });

    expect(decision).toEqual({ decision: 'accept' });
    // Each real path is gated individually (not the empty/grantRoot best-effort path).
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Edit', input: { file_path: '/repo/a.ts' } }),
    );
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Edit', input: { file_path: '/repo/b.ts' } }),
    );
  });

  it('declines the whole patch on the first denied path (all-or-nothing, short-circuits)', async () => {
    // Denied path FIRST: proves the loop stops at the first denial and never gates the rest
    // (a naive "gate all, return the last outcome" mutant would fail the call-count assert).
    const checkApproval = vi
      .fn()
      .mockResolvedValueOnce({ allowed: false, message: 'outside project' });
    const { result: decision } = await withTurn({ checkApproval }, (fake) => {
      fake.fire('item/started', {
        item: {
          type: 'fileChange',
          id: 'f1',
          changes: [{ path: '/etc/passwd' }, { path: '/repo/b.ts' }],
        },
      });
      return fake.invokeRequest(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'f1' });
    });

    // codex gets ONE decision per patch — a single denied path declines all of it,
    // and the second path is never gated (short-circuit).
    expect(decision).toEqual({ decision: 'decline' });
    expect(checkApproval).toHaveBeenCalledTimes(1);
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ input: { file_path: '/etc/passwd' } }),
    );
  });

  it('falls back to the grant root when the cached fileChange item has no usable paths', async () => {
    const checkApproval = vi.fn(async () => ({ allowed: true as const }));
    const { result: decision } = await withTurn({ checkApproval }, (fake) => {
      // Cached item present but path-less → resolves to the grantRoot Edit, not empty.
      fake.fire('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{}] } });
      return fake.invokeRequest(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'f1', grantRoot: '/repo' });
    });

    expect(decision).toEqual({ decision: 'accept' });
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ input: { file_path: '/repo' } }),
    );
  });

  it('falls back to a gated empty-path Edit when the approval has no cached item (cache miss)', async () => {
    // An approval with no preceding item/started must still GATE (never silent-accept):
    // it resolves to the empty-path safe default that prompts.
    const checkApproval = vi.fn(async () => ({ allowed: true as const }));
    const { result: decision } = await withTurn({ checkApproval }, (fake) =>
      fake.invokeRequest(FILE_CHANGE_APPROVAL_METHOD, { itemId: 'never-seen' }),
    );

    expect(decision).toEqual({ decision: 'accept' });
    expect(checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Edit', input: { file_path: '' } }),
    );
  });

  it('coalesces consecutive same-id text deltas queued under backpressure into one chunk', async () => {
    // Two same-id deltas queue before the first pull → coalesce at the tail; the
    // consumer sees one concatenated text-delta, no byte lost, still bracketed.
    const chunks = await deltaStream('item/agentMessage/delta', [
      ['i1', 'Hel'],
      ['i1', 'lo'],
    ]);
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'i1', delta: 'Hello' },
    ]);
    expect(chunks).toContainEqual({ type: 'text-start', id: 'i1' });
  });

  it('never coalesces across interleaved itemIds queued under backpressure', async () => {
    // i1, i2, i1 queue before the first pull: the tail-merge must NOT concat the two
    // i1 deltas across the i2 in between — three distinct deltas survive.
    const chunks = await deltaStream('item/agentMessage/delta', [
      ['i1', 'a'],
      ['i2', 'x'],
      ['i1', 'b'],
    ]);
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'i1', delta: 'a' },
      { type: 'text-delta', id: 'i2', delta: 'x' },
      { type: 'text-delta', id: 'i1', delta: 'b' },
    ]);
  });

  it('streams reasoning as a live Thinking tool card (same path as Claude)', async () => {
    // Reasoning must render, not vanish: makeChunkSink routes reasoning-delta through
    // the shared thinking emitter → a `Thinking` tool card, so the pane's pending
    // placeholder clears immediately instead of hanging until the answer arrives.
    const chunks = await deltaStream('item/reasoning/textDelta', [
      ['r1', 'think'],
      ['r1', 'ing'],
    ]);
    expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(false);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-input-start', toolName: 'Thinking' }),
    );
    // Accumulated reasoning text, and the card is closed by turn/completed.
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-input-available',
        toolName: 'Thinking',
        input: { text: 'thinking' },
      }),
    );
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
  });

  it('closes the Thinking card before the answer text (placeholder clears, ordering holds)', async () => {
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/reasoning/textDelta', { itemId: 'r1', delta: 'planning' });
      fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'Answer' });
    });
    const close = chunks.findIndex((c) => c.type === 'tool-output-available');
    const answerStart = chunks.findIndex((c) => c.type === 'text-start');
    expect(close).toBeGreaterThanOrEqual(0);
    expect(answerStart).toBeGreaterThan(close);
  });

  it('keeps one Thinking card open across a mid-reasoning token-usage tick', async () => {
    // thread/tokenUsage/updated → message-metadata must NOT close the card, else one
    // "Thought" fragments into several.
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/reasoning/textDelta', { itemId: 'r1', delta: 'a' });
      fake.fire('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 10 } } });
      fake.fire('item/reasoning/textDelta', { itemId: 'r1', delta: 'b' });
    });
    // Exactly one card open+close for the whole reasoning span.
    expect(chunks.filter((c) => c.type === 'tool-input-start')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'tool-output-available')).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-input-available', input: { text: 'ab' } }),
    );
  });

  it('inserts a blank-line break between reasoning summary sections', async () => {
    // summaryPartAdded marks a new hosted-model summary section; without a break the
    // sections render as one run-on paragraph.
    const { chunks } = await withTurn({}, (fake) => {
      fake.fire('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'first' });
      fake.fire('item/reasoning/summaryPartAdded', { itemId: 'r1' });
      fake.fire('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'second' });
    });
    const inputs = chunks.filter((c) => c.type === 'tool-input-available');
    const last = inputs[inputs.length - 1] as Extract<
      UIMessageChunk,
      { type: 'tool-input-available' }
    >;
    expect((last.input as { text: string }).text).toBe('first\n\nsecond');
  });

  it('closes an open Thinking card on abort mid-reasoning (finally flush)', async () => {
    const fake = startedFakeClient();
    const abortController = new AbortController();
    const gen = runCodexAgent(params({ abortController }));
    await gen.next(); // start
    await gen.next(); // message-metadata
    fake.fire('item/reasoning/textDelta', { itemId: 'r1', delta: 'mid' });
    const chunks: UIMessageChunk[] = [];
    // Pull the queued thinking chunks, then abort.
    chunks.push((await gen.next()).value as UIMessageChunk);
    abortController.abort();
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
  });

  it('clears host permission dedup state when a turn completes', async () => {
    const fake = startedFakeClient();
    const gen = runCodexAgent(params());
    await gen.next();
    await gen.next();
    rememberHostPermissionForStartedTurn();

    fake.fire('turn/completed', { turn: { id: 'tn1', status: 'completed' } });
    await drain(gen);

    expect(hasStartedTurnMcpPermission()).toBe(false);
  });

  it('clears host permission dedup state synchronously when a turn is aborted', async () => {
    startedFakeClient();
    const abortController = new AbortController();
    const gen = runCodexAgent(params({ abortController }));
    await gen.next();
    await gen.next();
    rememberHostPermissionForStartedTurn();

    abortController.abort();

    expect(hasStartedTurnMcpPermission()).toBe(false);
    await drain(gen);
  });

  it('interrupts the turn but keeps the warm server on abort', async () => {
    const fake = startedFakeClient();
    const abortController = new AbortController();

    const gen = runCodexAgent(params({ abortController }));
    await gen.next(); // start
    await gen.next(); // message-metadata (threadId + turnId now set)
    abortController.abort();
    for (let r = await gen.next(); !r.done; r = await gen.next());

    expect(fake.sent).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'th1', turnId: 'tn1' },
    });
    // Abort interrupts the turn only — the persistent server stays warm (registry owns teardown).
    expect(disposeCodexAppServerSession).not.toHaveBeenCalled();
  });

  it('ends the turn with an error chunk if the app-server connection closes mid-turn', async () => {
    const fake = startedFakeClient();

    const gen = runCodexAgent(params());
    await gen.next(); // start
    await gen.next(); // message-metadata — handlers (incl. onClose) registered
    fake.fireClose(); // process crashed: no turn/completed will ever arrive

    const rest: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) rest.push(r.value);
    expect(rest).toContainEqual({
      type: 'error',
      errorText: 'Codex app-server connection closed unexpectedly.',
    });
  });

  it('clears host permission dedup state when the app-server closes without turn/completed', async () => {
    const fake = startedFakeClient();
    const gen = runCodexAgent(params());
    await gen.next();
    await gen.next();
    rememberHostPermissionForStartedTurn();

    fake.fireClose();
    await drain(gen);

    expect(hasStartedTurnMcpPermission()).toBe(false);
  });

  it('ends the turn with an error chunk on a transport error that does not close', async () => {
    const fake = startedFakeClient();

    const gen = runCodexAgent(params());
    await gen.next(); // start
    await gen.next(); // message-metadata — onError handler registered
    fake.fireError([new Error('write EPIPE'), undefined, undefined]); // broken stdin, no close

    const rest: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) rest.push(r.value);
    expect(
      rest.some((c) => c.type === 'error' && c.errorText.includes('transport error: write EPIPE')),
    ).toBe(true);
  });

  it('surfaces a failed turn as an error chunk', async () => {
    const fake = startedFakeClient();

    const gen = runCodexAgent(params());
    await gen.next();
    await gen.next();
    fake.fire('turn/completed', { turn: { status: 'failed', error: { message: 'boom' } } });

    const rest: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) rest.push(r.value);
    expect(rest).toContainEqual({ type: 'error', errorText: 'boom' });
  });

  it('disposes the armed subscription when turn/start returns no turn id', async () => {
    const fake = makeFakeClient({
      'thread/start': { thread: { id: 'th1' } },
      'turn/start': {}, // no turn.id
    });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);
    const abortController = new AbortController();

    const gen = runCodexAgent(params({ abortController }));
    const chunks = await drain(gen);
    abortController.abort();

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'Codex did not return a turn id',
    });
    expect(fake.sent.some((s) => s.method === 'turn/interrupt')).toBe(false);
    expect(
      fake.invokeRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, {
        threadId: 'th1',
        turnId: 'future-turn',
        itemId: 'i1',
      }),
    ).toBeUndefined();
  });

  it('surfaces an error chunk when thread/start returns no thread id', async () => {
    // A server that answers thread/start with an empty object must not proceed to
    // turn/start with an undefined thread id — it errors cleanly.
    const fake = makeFakeClient({ 'thread/start': {} });
    vi.mocked(getCodexAppServer).mockResolvedValue(fake.client as never);

    const gen = runCodexAgent(params());
    const chunks: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'Codex did not return a thread id',
    });
    expect(fake.sent.some((s) => s.method === 'turn/start')).toBe(false);
  });

  it('yields a binary-missing message without spawning when getCodexAppServer rejects', async () => {
    // A spawn/handshake failure (e.g. dead binary) surfaces as an error+finish, not a hang.
    const fake = makeFakeClient();
    void fake;
    vi.mocked(getCodexAppServer).mockRejectedValue(new Error('handshake failed'));

    const gen = runCodexAgent(params());
    const chunks: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) chunks.push(r.value);

    expect(chunks).toContainEqual({ type: 'error', errorText: 'handshake failed' });
    expect(chunks.some((c) => c.type === 'finish')).toBe(true);
  });

  it('declines (does not throw) when checkApproval itself rejects', async () => {
    // If the gate blows up, the approval handler must fail safe to decline, never
    // leak the rejection back to the app-server (which expects a decision).
    const fake = startedFakeClient();
    const checkApproval = vi.fn().mockRejectedValue(new Error('gate crashed'));

    const gen = runCodexAgent(params({ checkApproval }));
    await gen.next();
    await gen.next();
    const decision = await fake.invokeRequest(COMMAND_APPROVAL_METHOD, { command: 'ls' });
    expect(decision).toEqual({ decision: 'decline' });

    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());
  });

  it('suppresses a transient (willRetry) error and keeps streaming', async () => {
    const fake = startedFakeClient();

    const gen = runCodexAgent(params());
    await gen.next();
    await gen.next();
    // A retryable error must NOT surface an error chunk nor end the stream.
    fake.fire('error', { error: { message: 'transient' }, willRetry: true });
    fake.fire('item/agentMessage/delta', { itemId: 'i1', delta: 'recovered' });
    fake.fire('turn/completed', { turn: { status: 'completed' } });

    const rest: UIMessageChunk[] = [];
    for (let r = await gen.next(); !r.done; r = await gen.next()) rest.push(r.value);
    expect(rest.some((c) => c.type === 'error')).toBe(false);
    expect(rest).toContainEqual({ type: 'text-delta', id: 'i1', delta: 'recovered' });
  });

  // Spawn-args contract: codex app-server REJECTS unknown args and exits (the client reads
  // it as an init timeout), and `computer_use` engages a macOS Apple-Events control prompt mid-turn.
  // getCodexAppServer is mocked, so assert on the args it received.
  it('disables every unrouted execution surface before configArgs', async () => {
    const fake = startedFakeClient();
    const gen = runCodexAgent(params({ configArgs: ['--config', 'mcp_servers.x={}'] }));
    await gen.next(); // start
    await gen.next(); // setup → getCodexAppServer invoked
    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());

    const opts = vi.mocked(getCodexAppServer).mock.calls[0]?.[2] as { args: string[] };
    expect(opts.args).toEqual([
      '--disable',
      'computer_use',
      '--disable',
      'code_mode',
      '--disable',
      'code_mode_host',
      '--disable',
      'code_mode_buffered_exec',
      '--disable',
      'code_mode_only',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      '--config',
      'mcp_servers.x={}',
      '--config',
      'shell_environment_policy.ignore_default_excludes=false',
    ]);
    expect(opts.args).not.toContain('--ignore-user-config');
    expect(opts.args).not.toContain('--skip-git-repo-check');
  });

  it('with no configArgs, spawns only the disable flags and the shell-env scrub', async () => {
    const fake = startedFakeClient();
    const gen = runCodexAgent(params());
    await gen.next();
    await gen.next();
    fake.fire('turn/completed', { turn: { status: 'completed' } });
    for (let r = await gen.next(); !r.done; r = await gen.next());

    const opts = vi.mocked(getCodexAppServer).mock.calls[0]?.[2] as { args: string[] };
    expect(opts.args).toEqual([
      '--disable',
      'computer_use',
      '--disable',
      'code_mode',
      '--disable',
      'code_mode_host',
      '--disable',
      'code_mode_buffered_exec',
      '--disable',
      'code_mode_only',
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      '--config',
      'shell_environment_policy.ignore_default_excludes=false',
    ]);
  });
});
