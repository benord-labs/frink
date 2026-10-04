/**
 * Drives CodexAppServerClient against an in-memory mock peer that speaks the
 * newline-delimited JSON-RPC wire protocol (no spawned process). Models the
 * peer on t3code's codex-app-server-mock-peer.ts: it reads client stdin lines
 * and writes bare {id,result} / {method,params} responses + notifications.
 *
 * Asserts: the initialize handshake (+ the initialized notification), a
 * turn/start round-trip, a server->client approval request returning a
 * decision, and notification dispatch.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { COMMAND_APPROVAL_METHOD, PERMISSIONS_APPROVAL_METHOD } from './codex-events';
import { FRINK_HOST_TOOL_PERMISSION_METHOD } from './codex-host-permissions';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Imported after the mocks so the client picks up the mocked spawn.
const { CodexAppServerClient } = await import('./app-server-client');

/** A fake child wired with PassThrough stdio that a mock peer can drive. */
function makeFakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  return child;
}

/** Mock peer: parses newline JSON from client stdin, writes bare responses to stdout. */
function attachMockPeer(
  child: ReturnType<typeof makeFakeChild>,
  onMessage: (msg: Record<string, unknown>, peer: { write: (m: unknown) => void }) => void,
) {
  const write = (m: unknown) => child.stdout.write(`${JSON.stringify(m)}\n`);
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) onMessage(JSON.parse(line) as Record<string, unknown>, { write });
      nl = buffer.indexOf('\n');
    }
  });
  return { write };
}

/** Wire messages carry an optional string `method`; parsed per-site instead of sniffed. */
const wireMethodSchema = z.object({ method: z.string().optional() });

const CLIENT_INFO = { name: 'frink', version: 'test' };
const HOST_CAPABILITIES = { frinkHostToolPermission: 1 };
const flush = () => new Promise((r) => setTimeout(r, 5));

/** Answer the initialize request so start() resolves, regardless of framing under test. */
function answerInitialize(child: ReturnType<typeof makeFakeChild>): void {
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        const msg = JSON.parse(line) as { id?: unknown; method?: string };
        if (msg.method === 'initialize') {
          child.stdout.write(
            `${JSON.stringify({
              id: msg.id,
              result: {
                userAgent: 'm',
                codexHome: '/h',
                platformFamily: 'unix',
                platformOs: 'linux',
                capabilities: HOST_CAPABILITIES,
              },
            })}\n`,
          );
        }
      }
      nl = buffer.indexOf('\n');
    }
  });
}

describe('CodexAppServerClient', () => {
  let child: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('performs the initialize handshake and sends the initialized notification', async () => {
    let initializeId: unknown;
    let initializeParams: unknown;
    let sawInitializedNotification = false;
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        initializeId = msg.id;
        initializeParams = msg.params;
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'mock',
            codexHome: '/home/.codex',
            platformFamily: 'unix',
            platformOs: 'macos',
            capabilities: HOST_CAPABILITIES,
          },
        });
      }
      if (msg.method === 'initialized' && msg.id === undefined) {
        sawInitializedNotification = true;
      }
    });

    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    const result = await client.start();

    // spawn was invoked as `codex app-server`.
    expect(spawnMock).toHaveBeenCalledWith('codex', ['app-server'], expect.any(Object));
    expect(initializeId).toBeDefined();
    expect(initializeParams).toMatchObject({
      capabilities: { frinkHostToolPermission: 1, experimentalApi: true },
    });
    expect(result.platformOs).toBe('macos');
    // Allow the initialized notification (fire-and-forget) to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(sawInitializedNotification).toBe(true);

    client.dispose();
    expect(child.kill).toHaveBeenCalled();
  });

  it('registers vendor skill roots after initialized and before start() resolves [sc-1731]', async () => {
    const sequence: string[] = [];
    attachMockPeer(child, (msg, peer) => {
      const method = wireMethodSchema.safeParse(msg).data?.method;
      if (method) sequence.push(method);
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
      }
      if (msg.method === 'skills/extraRoots/set') {
        expect(msg.params).toEqual({ extraRoots: ['/abs/skills'] });
        peer.write({ id: msg.id, result: {} });
      }
    });

    const client = new CodexAppServerClient({
      binary: 'codex',
      clientInfo: CLIENT_INFO,
      extraSkillRoots: ['/abs/skills'],
    });
    await client.start();

    // start() resolving proves the RPC was awaited: the registry hands the
    // client to thread/start only after start() returns.
    expect(sequence).toEqual(['initialize', 'initialized', 'skills/extraRoots/set']);
    client.dispose();
  });

  it('a rejected skill-roots RPC is non-fatal to start() [sc-1731]', async () => {
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
      }
      if (msg.method === 'skills/extraRoots/set') {
        peer.write({ id: msg.id, error: { code: -32600, message: 'nope' } });
      }
    });

    const client = new CodexAppServerClient({
      binary: 'codex',
      clientInfo: CLIENT_INFO,
      extraSkillRoots: ['/abs/skills'],
    });
    await expect(client.start()).resolves.toMatchObject({ platformOs: 'linux' });
    client.dispose();
  });

  it('sends no skill-roots RPC when none are staged [sc-1731]', async () => {
    const methods: string[] = [];
    attachMockPeer(child, (msg, peer) => {
      const method = wireMethodSchema.safeParse(msg).data?.method;
      if (method) methods.push(method);
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
      }
    });

    const client = new CodexAppServerClient({
      binary: 'codex',
      clientInfo: CLIENT_INFO,
      extraSkillRoots: [],
    });
    await client.start();
    await flush();
    expect(methods).toEqual(['initialize', 'initialized']);
    client.dispose();
  });

  it('fails closed and stops a binary without the Frink host capability', async () => {
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'stock',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
          },
        });
      }
    });

    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await expect(client.start()).rejects.toThrow('does not support Frink host permissions v1');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('round-trips a turn/start request and dispatches a notification', async () => {
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
        return;
      }
      if (msg.method === 'turn/start') {
        // Emit a streaming notification, then resolve the request.
        peer.write({
          method: 'item/agentMessage/delta',
          params: { threadId: 't1', turnId: 'u1', itemId: 'i1', delta: 'hello' },
        });
        peer.write({ id: msg.id, result: { turn: { id: 'u1' } } });
      }
    });

    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const deltas: string[] = [];
    client.forThread('t1').onNotification('item/agentMessage/delta', (params) => {
      deltas.push((params as { delta: string }).delta);
    });

    const turn = await client.sendRequest<{ turn: { id: string } }>('turn/start', {
      threadId: 't1',
      input: [{ type: 'text', text: 'hi' }],
    });

    expect(turn.turn.id).toBe('u1');
    expect(deltas).toEqual(['hello']);
    client.dispose();
  });

  it('answers a server->client approval request with a decision', async () => {
    let approvalResponse: Record<string, unknown> | undefined;
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
        return;
      }
      // The server sends the approval request only after turn/start (by which
      // point production code -- and this test -- has registered the handler).
      if (msg.method === 'turn/start') {
        peer.write({
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 't1', turnId: 'u1', itemId: 'i1', command: 'ls', startedAtMs: 1 },
        });
        peer.write({ id: msg.id, result: { turn: { id: 'u1' } } });
        return;
      }
      // The client's response to request 9001 comes back as {id:9001, result:{...}}.
      if (msg.id === 9001 && 'result' in msg) {
        approvalResponse = msg.result as Record<string, unknown>;
      }
    });

    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    // Handlers register post-start (mirrors the runner: client comes from the
    // registry already initialized, then approval handlers are attached per thread).
    client.forThread('t1').onRequest('item/commandExecution/requestApproval', () => ({
      decision: 'accept',
    }));
    await client.sendRequest('turn/start', { threadId: 't1', input: [] });

    await new Promise((r) => setTimeout(r, 10));
    expect(approvalResponse).toEqual({ decision: 'accept' });
    client.dispose();
  });

  it('binds the sole pending subscription before a first-tool request beats turn/start', async () => {
    let permissionResponse: Record<string, unknown> | undefined;
    let turnStartRequestId: unknown;
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
        return;
      }
      if (msg.method === 'turn/start') {
        turnStartRequestId = msg.id;
        peer.write({
          method: 'turn/started',
          params: { threadId: 't1', turn: { id: 'u1', status: 'inProgress' } },
        });
        peer.write({
          id: 9002,
          method: FRINK_HOST_TOOL_PERMISSION_METHOD,
          params: { threadId: 't1', turnId: 'u1', itemId: 'i1' },
        });
        return;
      }
      if (msg.id === 9002 && 'result' in msg) {
        permissionResponse = msg.result as Record<string, unknown>;
        peer.write({ id: turnStartRequestId, result: { turn: { id: 'u1' } } });
      }
    });

    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    const sub = client.forThread('t1');
    sub.onNotification('turn/started', () => undefined);
    sub.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, () => ({ decision: 'allow' }));
    sub.expectTurnStart();

    await client.sendRequest('turn/start', { threadId: 't1', input: [] });

    expect(permissionResponse).toEqual({ decision: 'allow' });
    client.dispose();
  });
});

describe('CodexAppServerClient NDJSON framing', () => {
  let child: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });
  afterEach(() => vi.clearAllMocks());

  it('reassembles a notification split across two stdout chunks (pipe fragmentation)', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const seen: unknown[] = [];
    client.forThread('t1').onNotification('item/agentMessage/delta', (p) => seen.push(p));

    // One JSON Message arrives in two halves, the newline only in the second write.
    const line = JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', itemId: 'i1', delta: 'hello' },
    });
    const mid = Math.floor(line.length / 2);
    child.stdout.write(line.slice(0, mid));
    await flush();
    expect(seen).toHaveLength(0); // nothing dispatched until the newline lands
    child.stdout.write(`${line.slice(mid)}\n`);
    await flush();

    // vscode-jsonrpc consumes the routing `jsonrpc` field; the handler sees the
    // original params (proving the two halves were reassembled into one Message).
    expect(seen).toEqual([{ threadId: 't1', itemId: 'i1', delta: 'hello' }]);
    client.dispose();
  });

  it('drops a garbage line and keeps dispatching subsequent valid messages', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const seen: string[] = [];
    client
      .forThread('t1')
      .onNotification('item/agentMessage/delta', (p) => seen.push((p as { delta: string }).delta));

    // A non-JSON line between two valid ones must not wedge the reader.
    child.stdout.write('this is not json{{{\n');
    child.stdout.write(
      `${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'after-garbage' } })}\n`,
    );
    await flush();

    expect(seen).toEqual(['after-garbage']);
    client.dispose();
  });

  it('handles CRLF framing and several messages in one chunk', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const seen: string[] = [];
    client
      .forThread('t1')
      .onNotification('item/agentMessage/delta', (p) => seen.push((p as { delta: string }).delta));

    const a = JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', delta: 'a' },
    });
    const b = JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', delta: 'b' },
    });
    // CRLF terminators + a blank line, all in a single data event.
    child.stdout.write(`${a}\r\n\r\n${b}\r\n`);
    await flush();

    expect(seen).toEqual(['a', 'b']);
    client.dispose();
  });

  it('routes a message that already carries jsonrpc without overwriting it', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const seen: unknown[] = [];
    client.forThread('t1').onNotification('item/agentMessage/delta', (p) => seen.push(p));
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'x' } })}\n`,
    );
    await flush();
    expect(seen).toEqual([{ threadId: 't1', delta: 'x' }]);
    client.dispose();
  });

  it('fires onClose when the child stdout ends (crash with no turn/completed)', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();

    const closed = vi.fn();
    client.onClose(closed);
    child.stdout.emit('end'); // process died
    await flush();
    expect(closed).toHaveBeenCalled();
    client.dispose();
  });
});

describe('CodexAppServerClient stdin errors (sc-966)', () => {
  let child: ReturnType<typeof makeFakeChild>;
  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  it('routes an async stdin EPIPE to onError instead of leaving it unhandled', async () => {
    // EPIPE arrives as a stream 'error' event, never as a write() throw. Unrouted, it is an
    // unhandled 'error' (uncaughtException) and the registry never learns the client is dead.
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    const errored = vi.fn();
    client.onError(errored);

    expect(() => child.stdin.emit('error', epipe())).not.toThrow();
    await flush();

    expect(errored).toHaveBeenCalledOnce();
    const [payload] = errored.mock.calls[0] as [[Error, unknown, unknown]];
    expect(payload[0].message).toBe('write EPIPE');
    client.dispose();
  });

  it('keeps a late stdin error after dispose() harmless', async () => {
    // dispose() SIGTERMs the child while a write may still be in flight; its EPIPE lands later.
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    const errored = vi.fn();
    client.onError(errored);
    client.dispose();

    expect(() => child.stdin.emit('error', epipe())).not.toThrow();
    await flush();
    expect(errored).not.toHaveBeenCalled();
  });

  it('does not throw when stdin breaks during the initialize handshake (child exited at once)', async () => {
    // A wrong or instantly-crashing binary breaks the pipe before initialize is answered.
    vi.useFakeTimers();
    try {
      const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
      const started = client.start();
      started.catch(() => {});
      expect(() => child.stdin.emit('error', epipe())).not.toThrow();
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(started).rejects.toThrow('did not respond to initialize');
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CodexAppServerClient lifecycle guards', () => {
  let child: ReturnType<typeof makeFakeChild>;
  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('throws on every connection-bound method before start()', () => {
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    expect(() => client.sendRequest('x')).toThrow('not started');
    expect(() => client.sendNotification('x')).toThrow('not started');
    expect(() => client.forThread('t')).toThrow('not started');
    expect(() => client.onClose(() => {})).toThrow('not started');
    expect(() => client.onError(() => {})).toThrow('not started');
  });

  it('rejects start() when the binary never answers initialize (hung process)', async () => {
    vi.useFakeTimers();
    // No mock peer: initialize is never answered → the 30s timeout must reject.
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    const startPromise = client.start();
    const assertion = expect(startPromise).rejects.toThrow(/did not respond to initialize/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    client.dispose();
    vi.useRealTimers();
  });

  it('dispose() is idempotent and kills the child once', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    client.dispose();
    client.dispose(); // second call is a no-op
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('force-kills an app-server that ignores SIGTERM, then rejects at the hard timeout', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    vi.useFakeTimers();

    const settlement = client.disposeAndWait();
    const assertion = expect(settlement).rejects.toThrow(
      'Codex app-server did not close after cancellation',
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(child.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(child.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles on close and cancels the pending force-kill', async () => {
    answerInitialize(child);
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    vi.useFakeTimers();

    const settlement = client.disposeAndWait();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);
    await settlement;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(child.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The sc-952 fix: one app-server client serves many concurrent turns, demultiplexed
 * by threadId, so two turns can't clobber each other's handlers (the original bug).
 */
describe('CodexAppServerClient threadId demux', () => {
  let child: ReturnType<typeof makeFakeChild>;
  beforeEach(() => {
    child = makeFakeChild();
    spawnMock.mockReturnValue(child);
  });
  afterEach(() => vi.clearAllMocks());

  /** Start a client and capture the {id → result} responses it writes back to the peer. */
  async function startWithCapture(): Promise<{
    client: InstanceType<typeof CodexAppServerClient>;
    responses: Map<number, unknown>;
    errors: Map<number, unknown>;
  }> {
    const responses = new Map<number, unknown>();
    const errors = new Map<number, unknown>();
    attachMockPeer(child, (msg, peer) => {
      if (msg.method === 'initialize') {
        peer.write({
          id: msg.id,
          result: {
            userAgent: 'm',
            codexHome: '/h',
            platformFamily: 'unix',
            platformOs: 'linux',
            capabilities: HOST_CAPABILITIES,
          },
        });
        return;
      }
      if (typeof msg.id === 'number' && 'result' in msg) responses.set(msg.id, msg.result);
      if (typeof msg.id === 'number' && 'error' in msg) errors.set(msg.id, msg.error);
    });
    const client = new CodexAppServerClient({ binary: 'codex', clientInfo: CLIENT_INFO });
    await client.start();
    return { client, responses, errors };
  }

  const notify = (threadId: string, turnId: string, delta: string) =>
    child.stdout.write(
      `${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'i', delta } })}\n`,
    );

  /** Two turn-bound subscriptions (u1, u2) on one thread, each capturing its received notifications. */
  function twoBoundNotifSubs(
    client: InstanceType<typeof CodexAppServerClient>,
    method: string,
    threadId = 't',
  ): { a: unknown[]; b: unknown[] } {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const subA = client.forThread(threadId);
    subA.onNotification(method, (p) => a.push(p));
    subA.bindTurn('u1');
    const subB = client.forThread(threadId);
    subB.onNotification(method, (p) => b.push(p));
    subB.bindTurn('u2');
    return { a, b };
  }

  /** An unbound subscription on a thread, capturing the delta strings it receives. */
  function deltaSub(client: InstanceType<typeof CodexAppServerClient>, threadId: string): string[] {
    const seen: string[] = [];
    client
      .forThread(threadId)
      .onNotification('item/agentMessage/delta', (p) => seen.push((p as { delta: string }).delta));
    return seen;
  }

  it('routes a notification only to its own thread (no cross-talk)', async () => {
    const { client } = await startWithCapture();
    const a = deltaSub(client, 'tA');
    const b = deltaSub(client, 'tB');
    notify('tA', 'u1', 'A');
    notify('tB', 'u2', 'B');
    await flush();
    expect(a).toEqual(['A']);
    expect(b).toEqual(['B']);
    client.dispose();
  });

  it('fans out to every subscription on a thread — a second subscribe never clobbers the first', async () => {
    const { client } = await startWithCapture();
    // Two subs on ONE thread; pre-fix the second REPLACED the first (the bug) — now both fire.
    const first = deltaSub(client, 't');
    const second = deltaSub(client, 't');
    notify('t', 'u1', 'x');
    await flush();
    expect(first).toEqual(['x']);
    expect(second).toEqual(['x']);
    client.dispose();
  });

  it('a bound turn ignores another turn’s notifications on the same thread', async () => {
    const { client } = await startWithCapture();
    const { a, b } = twoBoundNotifSubs(client, 'item/agentMessage/delta');
    notify('t', 'u1', 'A');
    notify('t', 'u2', 'B');
    await flush();
    expect((a as { delta: string }[]).map((p) => p.delta)).toEqual(['A']);
    expect((b as { delta: string }[]).map((p) => p.delta)).toEqual(['B']);
    client.dispose();
  });

  it('routes a turn-lifecycle event (id at turn.id, no top-level turnId) to only its own turn', async () => {
    // turn/started + turn/completed carry the turn id at turn.id, NOT top-level turnId
    // (codex v2). Without the turn.id fallback in readTurnId, the filter sees null and
    // a turn/completed from turn u1 would finish turn u2's stream on a shared thread.
    const { client } = await startWithCapture();
    const { a, b } = twoBoundNotifSubs(client, 'turn/completed');
    child.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u1', status: 'completed' } } })}\n`,
    );
    await flush();
    expect(a).toHaveLength(1); // u1's turn
    expect(b).toHaveLength(0); // u2 not finished by u1's completion
    client.dispose();
  });

  it('routes an approval to the turn whose turnId matches (same thread, two turns)', async () => {
    const { client, responses } = await startWithCapture();
    const subA = client.forThread('tX');
    subA.onRequest(COMMAND_APPROVAL_METHOD, () => ({ decision: 'accept' }));
    subA.bindTurn('u1');
    const subB = client.forThread('tX');
    subB.onRequest(COMMAND_APPROVAL_METHOD, () => ({ decision: 'decline' }));
    subB.bindTurn('u2');

    child.stdout.write(
      `${JSON.stringify({ id: 50, method: COMMAND_APPROVAL_METHOD, params: { threadId: 'tX', turnId: 'u2', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(responses.get(50)).toEqual({ decision: 'decline' }); // u2 → subB
    client.dispose();
  });

  it('routes a Frink host permission request only to its exact active turn', async () => {
    const { client, responses } = await startWithCapture();
    const gateA = vi.fn(() => ({ decision: 'allow' }));
    const gateB = vi.fn(() => ({ decision: 'deny' }));
    const subA = client.forThread('tX');
    subA.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gateA);
    subA.bindTurn('u1');
    const subB = client.forThread('tX');
    subB.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gateB);
    subB.bindTurn('u2');

    child.stdout.write(
      `${JSON.stringify({ id: 52, method: FRINK_HOST_TOOL_PERMISSION_METHOD, params: { threadId: 'tX', turnId: 'u2', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(gateA).not.toHaveBeenCalled();
    expect(gateB).toHaveBeenCalledTimes(1);
    expect(responses.get(52)).toEqual({ decision: 'deny' });
    client.dispose();
  });

  it('does not guess which pending same-thread subscription owns a new turn', async () => {
    const { client, responses } = await startWithCapture();
    const gateA = vi.fn(() => ({ decision: 'allow' }));
    const gateB = vi.fn(() => ({ decision: 'allow' }));
    const subA = client.forThread('tX');
    subA.onNotification('turn/started', () => undefined);
    subA.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gateA);
    subA.expectTurnStart();
    const subB = client.forThread('tX');
    subB.onNotification('turn/started', () => undefined);
    subB.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gateB);
    subB.expectTurnStart();

    child.stdout.write(
      `${JSON.stringify({ method: 'turn/started', params: { threadId: 'tX', turn: { id: 'u1' } } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ id: 55, method: FRINK_HOST_TOOL_PERMISSION_METHOD, params: { threadId: 'tX', turnId: 'u1', itemId: 'i' } })}\n`,
    );
    await flush();

    expect(gateA).not.toHaveBeenCalled();
    expect(gateB).not.toHaveBeenCalled();
    expect(responses.get(55)).toEqual({
      decision: 'deny',
      reason: 'No matching active Frink turn',
    });
    client.dispose();
  });

  it('does not bind an unarmed subscription from a replayed lifecycle event', async () => {
    const { client, responses } = await startWithCapture();
    const gate = vi.fn(() => ({ decision: 'allow' }));
    const sub = client.forThread('tX');
    sub.onNotification('turn/started', () => undefined);
    sub.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gate);

    child.stdout.write(
      `${JSON.stringify({ method: 'turn/started', params: { threadId: 'tX', turn: { id: 'old' } } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ id: 56, method: FRINK_HOST_TOOL_PERMISSION_METHOD, params: { threadId: 'tX', turnId: 'old', itemId: 'i' } })}\n`,
    );
    await flush();

    expect(gate).not.toHaveBeenCalled();
    expect(responses.get(56)).toEqual({
      decision: 'deny',
      reason: 'No matching active Frink turn',
    });
    client.dispose();
  });

  it('denies a Frink host request after its exact turn subscription is disposed', async () => {
    const { client, responses } = await startWithCapture();
    const gate = vi.fn(() => ({ decision: 'allow' }));
    const sub = client.forThread('tX');
    sub.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gate);
    sub.bindTurn('u1');
    sub.dispose();

    child.stdout.write(
      `${JSON.stringify({ id: 53, method: FRINK_HOST_TOOL_PERMISSION_METHOD, params: { threadId: 'tX', turnId: 'u1', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(gate).not.toHaveBeenCalled();
    expect(responses.get(53)).toEqual({
      decision: 'deny',
      reason: 'No matching active Frink turn',
    });
    client.dispose();
  });

  it('never falls back a Frink host request to the sole wrong turn', async () => {
    const { client, responses } = await startWithCapture();
    const gate = vi.fn(() => ({ decision: 'allow' }));
    const sub = client.forThread('tX');
    sub.onRequest(FRINK_HOST_TOOL_PERMISSION_METHOD, gate);
    sub.bindTurn('u2');

    child.stdout.write(
      `${JSON.stringify({ id: 54, method: FRINK_HOST_TOOL_PERMISSION_METHOD, params: { threadId: 'tX', turnId: 'u1', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(gate).not.toHaveBeenCalled();
    expect(responses.get(54)).toEqual({
      decision: 'deny',
      reason: 'No matching active Frink turn',
    });
    client.dispose();
  });

  it('declines (never mis-routes) an approval whose turnId matches no live turn on the thread', async () => {
    const { client, responses } = await startWithCapture();
    const gateA = vi.fn(() => ({ decision: 'accept' }));
    const gateB = vi.fn(() => ({ decision: 'accept' }));
    const subA = client.forThread('tX');
    subA.onRequest(COMMAND_APPROVAL_METHOD, gateA);
    subA.bindTurn('u1');
    const subB = client.forThread('tX');
    subB.onRequest(COMMAND_APPROVAL_METHOD, gateB);
    subB.bindTurn('u2');

    // turnId u3 belongs to neither live turn → must decline, NOT pick an arbitrary sub.
    child.stdout.write(
      `${JSON.stringify({ id: 51, method: COMMAND_APPROVAL_METHOD, params: { threadId: 'tX', turnId: 'u3', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(responses.get(51)).toEqual({ decision: 'decline' });
    expect(gateA).not.toHaveBeenCalled();
    expect(gateB).not.toHaveBeenCalled();
    client.dispose();
  });

  it('declines an orphaned approval and an unhandled permissions request (never leaves a hang)', async () => {
    const { client, responses } = await startWithCapture();
    client.forThread('known'); // live thread, but no approval handler registered

    child.stdout.write(
      `${JSON.stringify({ id: 60, method: COMMAND_APPROVAL_METHOD, params: { threadId: 'ghost', turnId: 'u' } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ id: 61, method: PERMISSIONS_APPROVAL_METHOD, params: { threadId: 'known', turnId: 'u' } })}\n`,
    );
    await flush();
    expect(responses.get(60)).toEqual({ decision: 'decline' }); // unknown thread
    expect(responses.get(61)).toEqual({ decision: 'decline' }); // method frink never gates
    client.dispose();
  });

  it('leaves unknown request methods to JSON-RPC MethodNotFound', async () => {
    const { client, responses, errors } = await startWithCapture();
    client.forThread('known');

    child.stdout.write(
      `${JSON.stringify({ id: 70, method: 'item/tool/requestUserInput', params: { threadId: 'known', turnId: 'u' } })}\n`,
    );
    await flush();
    expect(responses.get(70)).toBeUndefined();
    expect(errors.get(70)).toMatchObject({ code: -32_601 });
    client.dispose();
  });

  it('does not register a custom MCP elicitation responder', async () => {
    const { client, responses, errors } = await startWithCapture();
    client.forThread('known');

    child.stdout.write(
      `${JSON.stringify({ id: 71, method: 'mcpServer/elicitation/request', params: { threadId: 'known', turnId: null, serverName: 'github' } })}\n`,
    );
    await flush();
    expect(responses.get(71)).toBeUndefined();
    expect(errors.get(71)).toMatchObject({ code: -32_601 });
    client.dispose();
  });

  it('keeps unknown requests out of a live approval gate', async () => {
    const { client, responses, errors } = await startWithCapture();
    const bashGate = vi.fn(() => ({ decision: 'accept' }));
    const sub = client.forThread('tX');
    sub.onRequest(COMMAND_APPROVAL_METHOD, bashGate);
    sub.bindTurn('u1');

    child.stdout.write(
      `${JSON.stringify({ id: 80, method: 'mcpServer/elicitation/request', params: { threadId: 'tX', turnId: 'u1', serverName: 'github' } })}\n`,
    );
    await flush();
    expect(bashGate).not.toHaveBeenCalled();
    expect(responses.get(80)).toBeUndefined();
    expect(errors.get(80)).toMatchObject({ code: -32_601 });

    child.stdout.write(
      `${JSON.stringify({ id: 81, method: COMMAND_APPROVAL_METHOD, params: { threadId: 'tX', turnId: 'u1', itemId: 'i' } })}\n`,
    );
    await flush();
    expect(bashGate).toHaveBeenCalledTimes(1);
    expect(responses.get(81)).toEqual({ decision: 'accept' });
    client.dispose();
  });

  it('stops delivering to a disposed subscription', async () => {
    const { client } = await startWithCapture();
    const seen: string[] = [];
    const sub = client.forThread('t');
    sub.onNotification('item/agentMessage/delta', (p) => seen.push((p as { delta: string }).delta));
    sub.dispose();
    notify('t', 'u1', 'x');
    await flush();
    expect(seen).toEqual([]);
    client.dispose();
  });
});
