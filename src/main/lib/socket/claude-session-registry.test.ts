import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import electronLog from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProviderTopologyForTests,
  getClaudeTopologySnapshot,
} from '../diagnostics/provider-topology';
import { DEFAULT_MAX_CONCURRENT_FLOW_RUNS } from '../flows/admission/config';
import { channelOwner } from '../mcp/execution-identity';
import {
  __resetSessionsForTest,
  bindTurnAbort,
  claimRetainedSession,
  endSession,
  createSession,
  getSession,
  IDLE_TTL_MS,
  isPumpAdoptRefusedError,
  MAX_RETAINED_CLAUDE_SESSIONS,
  PREWARM_TTL_MS,
  prewarmBlocker,
  retainSession,
  retireRetainedSession,
  retireRetainedSessions,
  runPrewarm,
  settlePrewarm,
  unregisterSessionIfOwned,
} from './claude-session-registry';
import { disposeClaudeSessionAndWait } from './execution/claude-provider-cleanup';
import { armIdle, runTurn } from './execution/claude-session-loop';
import type { WakePumpCallbacks } from './execution/wake-pump-types';
import {
  __resetSubagentTaskStatusForTest,
  noteSubagentTaskFrame,
  setSubagentTaskPublisher,
} from './streaming/subagent-task-status';

const captureMainException = vi.hoisted(() => vi.fn());
const captureMainMessage = vi.hoisted(() => vi.fn());
vi.mock('../sentry/init', () => ({ captureMainException, captureMainMessage }));

const msg = (type: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type, ...extra }) as unknown as SDKMessage;
const resultMsg = (): SDKMessage => msg('result', { subtype: 'success', session_id: 's' });

const userTurn = (text: string): SDKUserMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  }) as unknown as SDKUserMessage;

const asQuery = (gen: AsyncGenerator<SDKMessage, void>): Query =>
  Object.assign(gen, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: async () => ({}) as never,
    supportedCommands: async () => [],
  }) as unknown as Query;

/** A `Query` whose stream is a fixed list of per-turn message batches. Driving it with
 * `.next()` across turns must resume the SAME generator; a `.return()` (from a bad
 * `for-await … break`) would end it and turn 2 would yield nothing. */
function makeFakeQuery(turns: SDKMessage[][]): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const batch of turns) for (const m of batch) yield m;
  }
  return asQuery(gen());
}

/** A `Query` whose first `.next()` rejects — models a CLI process/transport error mid-turn. */
function throwingQuery(err: Error): Query {
  // biome-ignore lint/correctness/useYield: yield-less by design — the stream must fail before producing anything
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    throw err;
  }
  return asQuery(gen());
}

/** A `Query` whose first `.next()` blocks until `release()`, then ends `done` — lets a test
 * hold a turn in flight while other things happen, then complete it. */
function gatedDeadQuery(): { query: Query; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // biome-ignore lint/correctness/useYield: yield-less by design — the stream must stay suspended, then end with no messages
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    await gate; // suspend the in-flight turn here
  }
  return { query: asQuery(gen()), release };
}

beforeEach(() => {
  __resetSessionsForTest();
  _resetProviderTopologyForTests();
  captureMainException.mockReset();
});

describe('claude-session-registry', () => {
  it('counts only a newly created Claude query, not a refused one', () => {
    const query = makeFakeQuery([]);
    createSession('topology', () => query);
    expect(() => createSession('topology', () => makeFakeQuery([]))).toThrow('adopt refused');

    expect(getClaudeTopologySnapshot()).toMatchObject({
      claudeQueryStartsTotal: 1,
      claudeQueryStarts60s: 1,
    });
  });

  it('runs a turn to its result and keeps the query alive for the next turn', async () => {
    const fq = makeFakeQuery([
      [msg('system'), msg('assistant'), resultMsg()],
      [msg('assistant'), resultMsg()],
    ]);
    const session = createSession('c1', () => fq);

    const turn1: string[] = [];
    await runTurn(session, userTurn('one'), (m) => {
      turn1.push(m.type);
    });
    expect(turn1).toEqual(['system', 'assistant', 'result']);

    // Second turn resumes the SAME generator — proves the demux did not .return() it.
    const turn2: string[] = [];
    await runTurn(session, userTurn('two'), (m) => {
      turn2.push(m.type);
    });
    expect(turn2).toEqual(['assistant', 'result']);
  });

  it('stops at result — does not bleed the next turn into this one', async () => {
    const fq = makeFakeQuery([
      [msg('assistant'), resultMsg()],
      [msg('assistant'), resultMsg()],
    ]);
    const session = createSession('c1b', () => fq);
    const seen: string[] = [];
    await runTurn(session, userTurn('x'), (m) => {
      seen.push(m.type);
    });
    expect(seen).toEqual(['assistant', 'result']); // turn-2 messages untouched
  });

  it('refuses a second session for a live chat as adopt-refused, leaving the first untouched', () => {
    let created = 0;
    const factory = () => {
      created += 1;
      return makeFakeQuery([[resultMsg()]]);
    };
    const first = createSession('c2', factory, { channel: 'tok-first' });
    // The executor's one-shot adopt-refused retry keys on this message to wait for the sibling.
    expect(() => createSession('c2', factory, { channel: 'tok-second' })).toThrow('adopt refused');
    expect(created).toBe(1);
    expect(getSession('c2')).toBe(first);
    expect(channelOwner('tok-first')).toEqual({ subChatId: 'c2', runtime: 'claude' });
    expect(channelOwner('tok-second')).toBeUndefined();
  });

  it('endSession closes the input stream and forgets the chat', () => {
    const session = createSession('c3', () => makeFakeQuery([[resultMsg()]]));
    expect(session.queue.closed).toBe(false);
    endSession('c3');
    expect(session.queue.closed).toBe(true);
    expect(getSession('c3')).toBeUndefined();
  });

  it('exact-session disposal waits for the turn and provider iterator cleanup', async () => {
    const query = makeFakeQuery([[resultMsg()]]);
    const returnQuery = vi.spyOn(query, 'return');
    const session = createSession('c3-flow', () => query);
    let settleTurn = () => {};
    session.turnSettled = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });

    const disposal = disposeClaudeSessionAndWait(session);
    expect(getSession('c3-flow')).toBeUndefined();
    expect(session.queue.closed).toBe(true);
    expect(returnQuery).not.toHaveBeenCalled();

    settleTurn();
    await disposal;
    expect(returnQuery).toHaveBeenCalledWith(undefined);
  });

  it('attempts provider iterator cleanup after turn settlement fails and aggregates both errors', async () => {
    const turnError = new Error('turn settlement failed');
    const providerError = new Error('provider return failed');
    const query = makeFakeQuery([[resultMsg()]]);
    const returnQuery = vi.spyOn(query, 'return').mockRejectedValueOnce(providerError);
    const session = createSession('c3-flow-errors', () => query);
    let rejectTurn = (_error: unknown) => {};
    session.turnSettled = new Promise<void>((_resolve, reject) => {
      rejectTurn = reject;
    });

    const disposal = disposeClaudeSessionAndWait(session);
    rejectTurn(turnError);

    await expect(disposal).rejects.toMatchObject({
      errors: [turnError, providerError],
    });
    expect(returnQuery).toHaveBeenCalledWith(undefined);
  });

  it('fails bounded cleanup visibly when the active turn never settles', async () => {
    vi.useFakeTimers();
    try {
      const query = makeFakeQuery([[resultMsg()]]);
      const returnQuery = vi.spyOn(query, 'return');
      const session = createSession('c3-flow-timeout', () => query);
      session.turnSettled = new Promise<void>(() => {});

      const disposal = disposeClaudeSessionAndWait(session);
      const rejection = expect(disposal).rejects.toThrow(
        'Claude session cleanup timed out waiting for the active turn',
      );
      await vi.runAllTimersAsync();

      await rejection;
      expect(returnQuery).toHaveBeenCalledWith(undefined);
      await vi.waitFor(() =>
        expect(captureMainException).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Claude session cleanup timed out waiting for the active turn',
          }),
          {
            surface: 'claude-provider-cleanup',
            stage: 'timeout',
            step: 'the active turn',
          },
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('exact-session disposal cannot evict a successor registered under the same chat id', async () => {
    const stale = createSession('c3-aba', () => makeFakeQuery([[resultMsg()]]));
    endSession('c3-aba');
    const successor = createSession('c3-aba', () => makeFakeQuery([[resultMsg()]]));

    await disposeClaudeSessionAndWait(stale);

    expect(getSession('c3-aba')).toBe(successor);
    expect(successor.queue.closed).toBe(false);
  });

  it('rejects a concurrent turn on the same session instead of corrupting the shared iterator', async () => {
    const session = createSession('k1', () => makeFakeQuery([[msg('assistant'), resultMsg()]]));
    const first = runTurn(session, userTurn('a'), () => {});
    // busy is set synchronously at entry, before `first` reaches its first await.
    await expect(runTurn(session, userTurn('b'), () => {})).rejects.toThrow('already in progress');
    await first; // the original turn still completes
    expect(session.busy).toBe(false);
  });

  it('realigns to the turn boundary after an onMessage error, keeping the session usable', async () => {
    const session = createSession('l1', () =>
      makeFakeQuery([
        [msg('assistant'), resultMsg()],
        [msg('assistant'), resultMsg()],
      ]),
    );
    await expect(
      runTurn(session, userTurn('a'), () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(session.busy).toBe(false);

    // Next turn must see ONLY its own messages — turn-a's leftover result was drained.
    const seen: string[] = [];
    await runTurn(session, userTurn('b'), (m) => {
      seen.push(m.type);
    });
    expect(seen).toEqual(['assistant', 'result']);
  });

  it('does not deadlock when onMessage throws on the turn result; the session recovers', async () => {
    const session = createSession('l2', () =>
      makeFakeQuery([
        [msg('assistant'), resultMsg()],
        [msg('assistant'), resultMsg()],
      ]),
    );
    await expect(
      runTurn(session, userTurn('a'), (m) => {
        if (m.type === 'result') throw new Error('boom-on-result');
      }),
    ).rejects.toThrow('boom-on-result');
    expect(session.busy).toBe(false); // NOT wedged (old code hung here forever)

    const seen: string[] = [];
    await runTurn(session, userTurn('b'), (m) => {
      seen.push(m.type);
    });
    expect(seen).toEqual(['assistant', 'result']);
  });

  it('evicts the dead session and errors when the query ends mid-turn, so the next turn recreates', async () => {
    let created = 0;
    const factory = () => {
      created += 1;
      return makeFakeQuery([[msg('assistant')]]); // ends `done` with no result — dead process
    };
    const session = createSession('f1', factory);
    const seen: string[] = [];
    await expect(
      runTurn(session, userTurn('a'), (m) => {
        seen.push(m.type);
      }),
    ).rejects.toThrow('ended before the turn produced a result');
    expect(seen).toEqual(['assistant']); // partial output before the death is still delivered
    expect(session.busy).toBe(false);
    expect(getSession('f1')).toBeUndefined(); // dead session evicted — no silent no-op forever

    createSession('f1', factory); // next turn spawns a fresh query
    expect(created).toBe(2);
  });

  it('evicts the session when the query itself errors mid-turn (dead process), surfacing the error', async () => {
    const session = createSession('e1', () => throwingQuery(new Error('spawn EPIPE')));
    await expect(runTurn(session, userTurn('a'), () => {})).rejects.toThrow('spawn EPIPE');
    expect(getSession('e1')).toBeUndefined(); // dead query evicted — next turn recreates
    expect(session.busy).toBe(false);
  });

  it("a stale in-flight turn's self-eviction does not kill a newer session under the same id (ABA)", async () => {
    const { query, release } = gatedDeadQuery();
    const s1 = createSession('aba', () => query);
    const staleTurn = runTurn(s1, userTurn('x'), () => {}); // enters the loop, awaits gated next()
    await Promise.resolve();

    // Chat closed then reopened under the same id while s1's turn is still in flight.
    endSession('aba'); // deletes s1, closes s1.queue
    const s2 = createSession('aba', () => makeFakeQuery([[resultMsg()]]));
    expect(s2).not.toBe(s1);

    release(); // s1's query now ends `done` → its self-eviction must NOT touch s2
    await expect(staleTurn).rejects.toThrow('ended before the turn produced a result');

    expect(getSession('aba')).toBe(s2); // the newer session survives
    expect(s2.queue.closed).toBe(false); // and was not collaterally closed
  });

  it('a turn dispatched after the session was ended fails loudly (close-during-dispatch race)', async () => {
    const session = createSession('j1', () => makeFakeQuery([[resultMsg()]]));
    endSession('j1'); // e.g. chat/tab closed between acquire and dispatch
    await expect(runTurn(session, userTurn('a'), () => {})).rejects.toThrow('push after close');
    expect(session.busy).toBe(false);
  });

  it('creates a fresh session after the previous one was ended (idle-evict / recreate)', () => {
    let created = 0;
    const factory = () => {
      created += 1;
      return makeFakeQuery([[resultMsg()]]);
    };
    const a = createSession('g1', factory);
    endSession('g1');
    const b = createSession('g1', factory);
    expect(b).not.toBe(a);
    expect(created).toBe(2);
  });
});

describe('Claude MCP channel per CLI', () => {
  const closable = () => Object.assign(makeFakeQuery([]), { close: vi.fn() });

  it("makes each new CLI's channel current and retires the one an ended, still-running CLI carries", () => {
    createSession('ch1', closable, { channel: 'tok-held' });
    expect(() => createSession('ch1', closable, { channel: 'tok-unused' })).toThrow();
    endSession('ch1'); // a Stop on a held chat closes stdin; its CLI may still be mid-burst
    createSession('ch1', closable, { channel: 'tok-next' });

    expect(channelOwner('tok-held')).toBeUndefined();
    expect(channelOwner('tok-unused')).toBeUndefined();
    expect(channelOwner('tok-next')).toEqual({ subChatId: 'ch1', runtime: 'claude' });
  });

  it("an abort on a superseded session closes it but leaves its successor's channel resolvable", () => {
    const controller = new AbortController();
    const superseded = createSession('ch2', closable, { channel: 'tok-old' });
    bindTurnAbort(superseded, controller.signal);
    endSession('ch2');
    createSession('ch2', closable, { channel: 'tok-successor' });

    controller.abort();

    expect(superseded.query.close).toHaveBeenCalledOnce();
    expect(channelOwner('tok-successor')).toEqual({ subChatId: 'ch2', runtime: 'claude' });
  });

  it('an abort on the attached session retires its own channel', () => {
    const controller = new AbortController();
    bindTurnAbort(createSession('ch3', closable, { channel: 'tok-own' }), controller.signal);

    controller.abort();

    expect(channelOwner('tok-own')).toBeUndefined();
  });
});

describe('idle sessions: retain, claim, retire', () => {
  const infoLog = vi.spyOn(electronLog, 'info');
  const logged = (prefix: string) =>
    infoLog.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith(prefix));
  const parts = { cwd: 'a', mcpServers: 'm1' };
  const spawn = (id: string) =>
    createSession(id, () => Object.assign(channelQuery().query, { close: vi.fn() }), {
      channel: `tok-${id}`,
      keyParts: parts,
      sdkSessionId: 'sess-1',
    });
  const idle = (id: string) => {
    const session = spawn(id);
    retainSession(session);
    return session;
  };
  const claim = (id: string, request: Partial<Parameters<typeof claimRetainedSession>[1]> = {}) =>
    claimRetainedSession(id, {
      keyParts: parts,
      persistedSessionId: 'sess-1',
      flowTurn: false,
      ...request,
    });

  beforeEach(() => infoLog.mockClear());
  afterEach(() => vi.useRealTimers());

  it('caps idle CLIs at no more than the default Flow run cap', () => {
    expect(MAX_RETAINED_CLAUDE_SESSIONS).toBeLessThanOrEqual(DEFAULT_MAX_CONCURRENT_FLOW_RUNS);
  });

  it('hands a matching idle session to the send, still registered and no longer idle', () => {
    const session = idle('hit');

    expect(claim('hit')).toBe(session);
    expect(session.retained).toBeNull();
    expect(getSession('hit')).toBe(session);
    expect(session.query.close).not.toHaveBeenCalled();
    expect(logged('[Claude Session] claim')).toEqual(['[Claude Session] claim sub=hit hit']);
  });

  it('logs miss:none and touches nothing when the chat has no idle session', () => {
    const live = spawn('live');

    expect(claim('live')).toEqual({ miss: 'none' });
    expect(getSession('live')).toBe(live);
    expect(logged('[Claude Session] claim')).toEqual(['[Claude Session] claim sub=live miss:none']);
  });

  it.each([
    ['key-mismatch:mcpServers', { keyParts: { ...parts, mcpServers: 'm2' } }],
    ['conversation-mismatch', { persistedSessionId: 'sess-other' }],
    ['conversation-mismatch', { persistedSessionId: '' }],
    ['flow-turn', { flowTurn: true }],
  ])('retires an idle session that cannot serve the send: %s', (reason, request) => {
    const session = idle('miss');

    expect(claim('miss', request)).toEqual({ miss: reason });
    expect(session.query.close).toHaveBeenCalledOnce();
    expect(getSession('miss')).toBeUndefined();
    // Part names only: a part's value can carry a credential.
    expect(logged('[Claude Session]')).toEqual([
      `[Claude Session] claim sub=miss miss:${reason}`,
      `[Claude Session] retire sub=miss reason=${reason}`,
    ]);
  });

  it('retires an idle session when its TTL runs out', () => {
    vi.useFakeTimers();
    const session = idle('ttl');

    vi.advanceTimersByTime(IDLE_TTL_MS - 1);
    expect(getSession('ttl')).toBe(session);
    vi.advanceTimersByTime(1);

    expect(getSession('ttl')).toBeUndefined();
    expect(session.query.close).toHaveBeenCalledOnce();
    expect(logged('[Claude Session] retire')).toEqual([
      '[Claude Session] retire sub=ttl reason=idle-ttl',
    ]);
  });

  it('a TTL that runs out after the claim does nothing', () => {
    vi.useFakeTimers();
    const session = idle('ttl-claimed');
    claim('ttl-claimed');

    vi.advanceTimersByTime(IDLE_TTL_MS * 2);

    expect(getSession('ttl-claimed')).toBe(session);
    expect(session.query.close).not.toHaveBeenCalled();
  });

  it('a claim after the machine slept past the TTL misses as expired, though no timer fired', () => {
    vi.useFakeTimers();
    const session = idle('slept');

    vi.setSystemTime(Date.now() + IDLE_TTL_MS);
    expect(getSession('slept')).toBe(session);

    expect(claim('slept')).toEqual({ miss: 'expired' });
    expect(session.query.close).toHaveBeenCalledOnce();
  });

  it('over the cap, retires the oldest idle session and never a busy, held, draining or spawning one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const busy = spawn('cap-busy');
    void runTurn(busy, userTurn('working'), () => {});
    const held = spawn('cap-held');
    armIdle(held, { ...noWake, isWorkFinished: () => false });
    const drainCh = channelQuery();
    const draining = createSession('cap-draining', () => drainCh.query);
    armIdle(draining, { ...noWake, isWorkFinished: () => true });
    drainCh.emit(resultMsg());
    await vi.waitFor(() => expect(draining.loop.closeExpected).toBe(true));
    const spawning = spawn('cap-spawning');
    const idles = ['cap-1', 'cap-2', 'cap-3', 'cap-4'].map((id) => {
      vi.setSystemTime(Date.now() + 1_000);
      return idle(id);
    });

    const newest = idle('cap-5');

    expect(getSession('cap-1')).toBeUndefined();
    expect(idles[0]?.query.close).toHaveBeenCalledOnce();
    for (const kept of [...idles.slice(1), newest, busy, held, draining, spawning]) {
      expect(getSession(kept.subChatId)).toBe(kept);
    }
    expect(logged('[Claude Session] retire')).toEqual([
      '[Claude Session] retire sub=cap-1 reason=idle-cap',
    ]);
  });

  it('retires only idle sessions: CLI closed, channel retired, one reason logged', () => {
    const retained = idle('idle-1');
    const busy = spawn('idle-busy');

    retireRetainedSession('idle-1', 'provider-switch');
    retireRetainedSession('idle-1', 'provider-switch');
    retireRetainedSession('idle-busy', 'provider-switch');

    expect(retained.query.close).toHaveBeenCalledOnce();
    expect(retained.queue.closed).toBe(true);
    expect(getSession('idle-1')).toBeUndefined();
    expect(channelOwner('tok-idle-1')).toBeUndefined();
    expect(getSession('idle-busy')).toBe(busy);
    expect(logged('[Claude Session] retire')).toEqual([
      '[Claude Session] retire sub=idle-1 reason=provider-switch',
    ]);
  });

  it('sweeps every idle session at once, and retires a live one when its turn ends', () => {
    const a = idle('sweep-a');
    const b = idle('sweep-b');
    const live = spawn('sweep-live');

    retireRetainedSessions('credential-change');

    expect(a.query.close).toHaveBeenCalledOnce();
    expect(b.query.close).toHaveBeenCalledOnce();
    expect(getSession('sweep-live')).toBe(live);
    retainSession(live);
    expect(getSession('sweep-live')).toBeUndefined();
    expect(live.query.close).toHaveBeenCalledOnce();
    expect(logged('[Claude Session] retire sub=sweep-live')).toEqual([
      '[Claude Session] retire sub=sweep-live reason=credential-change',
    ]);
  });

  it('a sweep between reading a spawn’s inputs and its spawn fences it; a later spawn is kept', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const readAt = Date.now();
    vi.setSystemTime(readAt + 1_000);
    retireRetainedSessions('mcp-config-change');
    vi.setSystemTime(readAt + 2_000);
    const query = () => Object.assign(channelQuery().query, { close: vi.fn() });
    const stale = createSession('sweep-stale', query, { inputsReadAt: readAt });
    const fresh = spawn('sweep-fresh');

    retainSession(stale);
    retainSession(fresh);

    expect(getSession('sweep-stale')).toBeUndefined();
    expect(fresh.retained).not.toBeNull();
  });
});

describe('pre-warmed sessions: TTL, cap, teardown fence, claim', () => {
  const infoLog = vi.spyOn(electronLog, 'info');
  const retires = () =>
    infoLog.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(' retire '));
  const parts = { cwd: 'a' };
  const spawn = (id: string, sdkSessionId = 'sess-1') =>
    createSession(id, () => Object.assign(channelQuery().query, { close: vi.fn() }), {
      keyParts: parts,
      sdkSessionId,
    });
  const prewarmed = (id: string, sdkSessionId?: string) => {
    const session = spawn(id, sdkSessionId);
    retainSession(session, { prewarm: true });
    return session;
  };
  const used = (id: string) => {
    const session = spawn(id);
    retainSession(session);
    return session;
  };
  const claim = (id: string, persistedSessionId: string | undefined) =>
    claimRetainedSession(id, { keyParts: parts, persistedSessionId, flowTurn: false });

  beforeEach(() => infoLog.mockClear());
  afterEach(() => vi.useRealTimers());

  it('waits 3 minutes, not the idle TTL, and a later claim misses as expired', () => {
    vi.useFakeTimers();
    const timedOut = prewarmed('pw-ttl');
    vi.advanceTimersByTime(PREWARM_TTL_MS);
    const slept = prewarmed('pw-slept');
    vi.setSystemTime(Date.now() + PREWARM_TTL_MS);

    expect(claim('pw-slept', 'sess-1')).toEqual({ miss: 'expired' });
    expect(PREWARM_TTL_MS).toBeLessThan(IDLE_TTL_MS);
    expect(timedOut.query.close).toHaveBeenCalledOnce();
    expect(slept.query.close).toHaveBeenCalledOnce();
    expect(retires()).toEqual([
      '[Claude Session] retire sub=pw-ttl reason=idle-ttl prewarm',
      '[Claude Session] retire sub=pw-slept reason=expired prewarm',
    ]);
  });

  it('pre-warms share the cap’s room; a turn-end retain evicts unused pre-warms first', () => {
    const kept = ['u1', 'u2'].map(used);
    const first = prewarmed('pw-1');
    const second = prewarmed('pw-2');
    expect(first.retained).not.toBeNull();
    kept.push(used('u3'));

    expect(first.query.close).toHaveBeenCalledOnce();
    expect(getSession('pw-2')).toBe(second);
    kept.push(used('u4'));

    expect(second.query.close).toHaveBeenCalledOnce();
    for (const session of kept) expect(session.retained).not.toBeNull();
    expect(retires()).toEqual([
      '[Claude Session] retire sub=pw-1 reason=idle-cap prewarm',
      '[Claude Session] retire sub=pw-2 reason=idle-cap prewarm',
    ]);
  });

  it('never evicts a session that ran a turn: over a full cap the pre-warm gives way', () => {
    const kept = ['c1', 'c2', 'c3', 'c4'].map(used);

    expect(prewarmBlocker('pw-full')).toBe('cap-full');
    const late = prewarmed('pw-full');

    expect(late.query.close).toHaveBeenCalledOnce();
    for (const session of kept) expect(session.retained).not.toBeNull();
  });

  it('with one slot left the newest pre-warm keeps it: another chat’s pre-warm gives way', () => {
    const kept = ['n1', 'n2', 'n3'].map(used);
    const first = prewarmed('pw-kept');

    expect(prewarmBlocker('pw-late')).toBe('cap-full');
    const late = prewarmed('pw-late');

    expect(late.query.close).toHaveBeenCalledOnce();
    expect(getSession('pw-kept')).toBe(first);
    for (const session of kept) expect(session.retained).not.toBeNull();
  });

  it('a pre-warm that never ran a turn serves a send that starts its conversation', () => {
    const fresh = prewarmed('pw-new', '');
    expect(claim('pw-new', undefined)).toBe(fresh);
    prewarmed('pw-resumed');
    expect(claim('pw-resumed', undefined)).toEqual({ miss: 'conversation-mismatch' });
    retainSession(spawn('turned', ''));
    expect(claim('turned', undefined)).toEqual({ miss: 'conversation-mismatch' });
  });

  it('a teardown of its chat while a pre-warm spawns retires the CLI as it lands', async () => {
    let land = () => {};
    let landed: ReturnType<typeof prewarmed> | undefined;
    const done = runPrewarm('pw-gone', async () => {
      await new Promise<void>((resolve) => (land = resolve));
      landed = prewarmed('pw-gone');
      return 'spawned';
    });
    retireRetainedSession('pw-other', 'archive');
    retireRetainedSession('pw-gone', 'delete');
    land();
    await done;

    expect(landed?.query.close).toHaveBeenCalledOnce();
    expect(getSession('pw-gone')).toBeUndefined();
    expect(retires()).toEqual(['[Claude Session] retire sub=pw-gone reason=delete']);
    expect(prewarmed('pw-gone').retained?.prewarm).toBe(true);
  });

  it('runs one pre-warm at a time, and a send for its chat waits for it', async () => {
    let finish = (_outcome: string) => {};
    const done = runPrewarm('pw-flight', () => new Promise((resolve) => (finish = resolve)));
    let settled = false;
    const waiting = settlePrewarm('pw-flight').then(() => (settled = true));

    expect(prewarmBlocker('pw-other')).toBe('in-flight');
    expect(prewarmBlocker('pw-flight')).toBe('session');
    await settlePrewarm('pw-other');
    expect(settled).toBe(false);
    finish('spawned');
    await waiting;

    expect(await done).toBe('spawned');
    expect(prewarmBlocker('pw-other')).toBeNull();
    used('pw-busy');
    expect(prewarmBlocker('pw-busy')).toBe('session');
  });
});

const noWake: WakePumpCallbacks = {
  onBurstStart: () => {},
  onMessage: () => {},
  onBurstEnd: () => {},
  onWaitOver: () => {},
  isWorkFinished: () => false,
};

/** A `Query` the test feeds live: `emit()` releases messages to the pending `.next()`, `end()`
 * finishes the stream — as the CLI does once it has drained the work it still owed after its stdin
 * closed. `interrupt()` ends it too. Models harness wake bursts arriving BETWEEN turns. */
function channelQuery(): { query: Query; emit: (m: SDKMessage) => void; end: () => void } {
  const buffer: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const release = () => {
    wake?.();
    wake = null;
  };
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      while (buffer.length > 0) yield buffer.shift() as SDKMessage;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const query = asQuery(gen());
  (query as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {
    ended = true;
    release();
  };
  return {
    query,
    emit: (m) => {
      buffer.push(m);
      release();
    },
    end: () => {
      ended = true;
      release();
    },
  };
}

describe('armIdle', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  type BurstLog = { starts: number; messages: string[]; ends: number };
  const collectingCallbacks = (log: BurstLog, maxBursts = 5): WakePumpCallbacks => ({
    onBurstStart: () => {
      log.starts += 1;
    },
    onMessage: (m) => {
      log.messages.push((m as { type: string }).type);
    },
    onBurstEnd: () => {
      log.ends += 1;
    },
    onWaitOver: () => {},
    // The pump holds no policy of its own; a burst cap stands in for the arming side's liveness rule.
    isWorkFinished: () => log.ends >= maxBursts,
  });

  it('delivers each wake burst through onBurstStart/onMessage/onBurstEnd and stays armed', async () => {
    const ch = channelQuery();
    const session = createSession('p1', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    expect(session.busy).toBe(true);

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual({ starts: 1, messages: ['system', 'assistant', 'result'], ends: 1 });
    expect(session.busy).toBe(true); // still armed for the next wake

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    expect(log.starts).toBe(2);

    ch.end();
    expect((await pump.done).reason).toBe('stream-ended');
    expect(session.busy).toBe(false);
  });

  it('ends the wait, closes stdin, and finishes when the CLI ends its own stream', async () => {
    const ch = channelQuery();
    const session = createSession('p2', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 2));
    for (let i = 0; i < 2; i++) {
      ch.emit(msg('assistant'));
      ch.emit(resultMsg());
    }
    // The wait's advertisement ends here; the reading does not, so the arming outlives it.
    await vi.waitFor(() => expect(session.queue.closed).toBe(true));
    expect(session.busy).toBe(false);
    expect(pump.isEnded()).toBe(false);

    ch.end(); // the CLI finishes what it still owed and exits
    expect(await pump.done).toEqual({ reason: 'work-finished', bursts: 2 });
  });

  it('keeps consuming wakes for as long as the arming side returns no cause', async () => {
    const ch = channelQuery();
    const session = createSession('p2-liveness', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    // A wake count bears no relation to how long the watched work runs (a Monitor fires per matched
    // output line), so nothing but the arming side's liveness rule may stop the pump.
    const pump = armIdle(session, { ...collectingCallbacks(log), isWorkFinished: () => false });
    for (let i = 0; i < 20; i++) {
      ch.emit(msg('assistant'));
      ch.emit(resultMsg());
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(log.ends).toBe(20);
    expect(session.busy).toBe(true);

    ch.end();
    expect((await pump.done).reason).toBe('stream-ended');
  });

  it('refreshes lastActiveAt on every frame — a long mid-burst wait still reads as attended', async () => {
    const ch = channelQuery();
    const session = createSession('p13', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    armIdle(session, collectingCallbacks(log, 5));

    session.lastActiveAt = 0; // simulate a stale clock; any frame must refresh it
    ch.emit(msg('assistant')); // mid-burst frame, no result yet
    await new Promise((r) => setTimeout(r, 0));
    expect(session.lastActiveAt).toBeGreaterThan(0);

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('an exited pump reports isEnded and refuses startTurn instead of hanging', async () => {
    const ch = channelQuery();
    const session = createSession('p12', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    expect(pump.isEnded()).toBe(false);

    ch.end();
    expect((await pump.done).reason).toBe('stream-ended');
    expect(pump.isEnded()).toBe(true);
    // The loop has returned — a push would sit in the queue with no reader, hanging the caller.
    const rejection = await pump.startTurn(userTurn('late'), () => {}).catch((err) => err);
    expect(rejection).toBeInstanceOf(Error);
    // The executor's fresh-session fallback keys off this predicate — keep them in sync.
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);
  });

  it('startTurn from idle pushes immediately and routes the turn to its own sink', async () => {
    const ch = channelQuery();
    const session = createSession('p3', () => ch.query);
    const pushed: string[] = [];
    const originalPush = session.queue.push.bind(session.queue);
    session.queue.push = (m) => {
      pushed.push('pushed');
      originalPush(m);
    };
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    const turnSeen: string[] = [];
    const turnDone = pump.startTurn(userTurn('hi'), (m) => {
      turnSeen.push((m as { type: string }).type);
    });
    expect(pushed).toEqual(['pushed']); // idle → immediate push

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await turnDone;
    expect(turnSeen).toEqual(['assistant', 'result']);
    expect(log.starts).toBe(0); // nothing was attributed to a wake burst
    expect((await pump.done).reason).toBe('turn-taken-over');
    expect(session.busy).toBe(false);
  });

  it('classifies an adopted-turn sink failure separately from wake cleanup', async () => {
    const ch = channelQuery();
    const session = createSession('p-turn-error', () => ch.query);
    const pump = armIdle(session, collectingCallbacks({ starts: 0, messages: [], ends: 0 }, 5));
    const turnError = new Error('foreground turn sink failed');
    const turnDone = pump.startTurn(userTurn('hi'), () => {
      throw turnError;
    });

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());

    await expect(turnDone).rejects.toBe(turnError);
    expect(await pump.done).toEqual({ reason: 'turn-error', error: turnError });
    expect(getSession('p-turn-error')).toBe(session);
    ch.end();
  });

  it('startTurn runs beforePush at actual push time — after a mid-burst wait, before the turn frames', async () => {
    const ch = channelQuery();
    const session = createSession('p11', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    ch.emit(msg('system', { subtype: 'task_notification' }));
    await new Promise((r) => setTimeout(r, 0)); // mid-burst

    const order: string[] = [];
    const turnDone = pump.startTurn(
      userTurn('hi'),
      (m) => {
        order.push(`turn:${(m as { type: string }).type}`);
      },
      () => {
        order.push('beforePush');
      },
    );
    expect(order).toEqual([]); // mid-burst: swap deferred with the push

    ch.emit(resultMsg()); // burst completes → push happens now, swap first
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['beforePush']);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await turnDone;
    expect(order).toEqual(['beforePush', 'turn:assistant', 'turn:result']);
    expect((await pump.done).reason).toBe('turn-taken-over');
  });

  it('awaits asynchronous beforePush work before enqueueing the takeover turn', async () => {
    const ch = channelQuery();
    const session = createSession('p13', () => ch.query);
    const pushes: string[] = [];
    const originalPush = session.queue.push.bind(session.queue);
    session.queue.push = (m) => {
      pushes.push('turn');
      originalPush(m);
    };
    const pump = armIdle(session, collectingCallbacks({ starts: 0, messages: [], ends: 0 }, 5));
    let releasePreparation = () => {};
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });

    const turnDone = pump.startTurn(
      userTurn('hi'),
      () => {},
      async () => {
        await preparation;
      },
    );
    expect(pushes).toEqual([]);

    releasePreparation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushes).toEqual(['turn']);

    ch.emit(resultMsg());
    await turnDone;
    expect((await pump.done).reason).toBe('turn-taken-over');
  });

  it('does not enqueue a takeover cancelled while asynchronous beforePush work is pending', async () => {
    const ch = channelQuery();
    const session = createSession('p13-cancel', () => ch.query);
    const pushes: SDKUserMessage[] = [];
    const originalPush = session.queue.push.bind(session.queue);
    session.queue.push = (message) => {
      pushes.push(message);
      originalPush(message);
    };
    const pump = armIdle(session, collectingCallbacks({ starts: 0, messages: [], ends: 0 }, 5));
    ch.emit(msg('assistant'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    let finishPreparation = () => {};
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });

    const turnDone = pump.startTurn(
      userTurn('must not launch'),
      () => {},
      async () => {
        await preparation;
        return false;
      },
    );
    ch.emit(resultMsg());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushes).toEqual([]);

    finishPreparation();
    const rejection = await turnDone.catch((error) => error);
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);
    expect(await pump.done).toEqual({ reason: 'interrupted' });
    expect(pushes).toEqual([]);
    ch.end();
  });

  it('startTurn mid-burst defers the push until the burst result, then routes the turn', async () => {
    const ch = channelQuery();
    const session = createSession('p4', () => ch.query);
    const pushes: number[] = [];
    const originalPush = session.queue.push.bind(session.queue);
    session.queue.push = (m) => {
      pushes.push(Date.now());
      originalPush(m);
    };
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    await new Promise((r) => setTimeout(r, 0)); // mid-burst (no result yet)
    expect(log.starts).toBe(1);

    const turnSeen: string[] = [];
    const turnDone = pump.startTurn(userTurn('hi'), (m) => {
      turnSeen.push((m as { type: string }).type);
    });
    expect(pushes).toHaveLength(0); // mid-burst → push deferred

    ch.emit(resultMsg()); // burst completes
    await new Promise((r) => setTimeout(r, 0));
    expect(log.ends).toBe(1);
    expect(pushes).toHaveLength(1); // …now the turn was pushed

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await turnDone;
    expect(turnSeen).toEqual(['assistant', 'result']);
    expect((await pump.done).reason).toBe('turn-taken-over');
  });

  it('an expected interrupt ends the pump gracefully and keeps the session registered', async () => {
    const ch = channelQuery();
    const session = createSession('p5', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    session.interruptExpected = true;
    await session.query.interrupt();
    expect((await pump.done).reason).toBe('interrupted');
    expect(session.busy).toBe(false);
    expect(getSession('p5')).toBe(session);
  });

  it('refuses a second arming on the same session', async () => {
    const ch = channelQuery();
    const session = createSession('p6', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    expect(() => armIdle(session, collectingCallbacks(log, 5))).toThrow('already in progress');
    ch.end();
    await pump.done;
  });

  it('an unexpected stream end during a pump evicts the session (dead query)', async () => {
    const ch = channelQuery();
    const session = createSession('p7', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    ch.end(); // CLI died with no interrupt expected
    expect((await pump.done).reason).toBe('stream-ended');
    expect(getSession('p7')).toBeUndefined();
  });

  it('ambient status frames at idle do not open a burst; the real wake after them does', async () => {
    const ch = channelQuery();
    const session = createSession('p8', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    // Harness status noise between turns: never followed by a `result`, so opening a burst on
    // one would wedge burst bookkeeping and defer a takeover push against a result that never
    // comes.
    ch.emit(msg('system', { subtype: 'task_progress' }));
    ch.emit(msg('system', { subtype: 'task_updated' }));
    ch.emit(msg('system', { subtype: 'session_state_changed' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(log.starts).toBe(0);

    // A takeover requested during ambient noise pushes immediately (the pump is still idle).
    const turnSeen: string[] = [];
    const turnDone = pump.startTurn(userTurn('hi'), (m) => {
      turnSeen.push((m as { type: string }).type);
    });
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await turnDone;
    expect(turnSeen).toEqual(['assistant', 'result']);
    expect(log.starts).toBe(0);
    expect((await pump.done).reason).toBe('turn-taken-over');
  });

  it('a task_notification at idle DOES open a burst (it precedes a real wake turn)', async () => {
    const ch = channelQuery();
    const session = createSession('p9', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));
    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    expect(log.starts).toBe(1);
    expect(log.messages).toEqual(['system', 'assistant', 'result']);
    ch.end();
    await pump.done;
  });

  it('a pump dying mid-burst REJECTS an unpushed takeover instead of silently dropping the message', async () => {
    const ch = channelQuery();
    const session = createSession('p12', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    ch.emit(msg('system', { subtype: 'task_notification' })); // burst opens
    await new Promise((r) => setTimeout(r, 0));

    const turnDone = pump.startTurn(userTurn('queued behind the burst'), () => {});
    ch.end(); // the CLI dies before the burst's result — the deferred push never happens
    const rejection = await turnDone.catch((err) => err);
    expect(String(rejection)).toContain('before the takeover turn started');
    // Nothing was pushed or streamed — the executor's fresh-session retry must recognize this
    // rejection too, not only startTurn's post-exit pre-check.
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);
    expect((await pump.done).reason).toBe('stream-ended');
  });

  it('startTurn racing endSession rejects cleanly instead of hanging (queue closed under it)', async () => {
    const ch = channelQuery();
    const session = createSession('p10', () => ch.query);
    const log: BurstLog = { starts: 0, messages: [], ends: 0 };
    const pump = armIdle(session, collectingCallbacks(log, 5));

    endSession('p10'); // e.g. user Stop / chat delete between adoption check and push
    ch.end(); // …the CLI exits once its stdin closes
    await expect(pump.startTurn(userTurn('too late'), () => {})).rejects.toThrow(
      'push after close',
    );
    // The pump itself settles via its stream-end path — no dangling busy session.
    await pump.done;
    expect(session.busy).toBe(false);
  });
});

/**
 * The CLI runs turns of its own — a task notification it enqueued, or the `Continue from where you
 * left off.` continuation after an interrupt — and each ends in its own `result`. A loop that stops
 * at the first `result` files that turn as the reply to the user's message and abandons the real
 * one, still unread, behind it.
 */
describe('harness turns do not end ours', () => {
  const harnessResult = (): SDKMessage =>
    msg('result', { subtype: 'success', session_id: 's', origin: { kind: 'task-notification' } });

  type Burst = { starts: number; ends: number };
  const burstCallbacks = (log: Burst, maxBursts: number): WakePumpCallbacks => ({
    onBurstStart: () => {
      log.starts += 1;
    },
    onMessage: () => {},
    onBurstEnd: () => {
      log.ends += 1;
    },
    onWaitOver: () => {},
    isWorkFinished: () => log.ends >= maxBursts,
  });

  beforeEach(() => {
    __resetSessionsForTest();
  });

  it('runTurn streams past a harness result and returns only on ours', async () => {
    const seen: SDKMessage[] = [];
    const session = createSession('h1', () =>
      makeFakeQuery([[harnessResult(), msg('assistant'), resultMsg()]]),
    );

    await runTurn(session, userTurn('answer'), (m) => {
      seen.push(m);
    });

    // All three delivered, in order — the assistant frame after the harness result is the real reply.
    expect(seen.map((m) => m.type)).toEqual(['result', 'assistant', 'result']);
    expect(session.busy).toBe(false);
  });

  it('a taken-over pump turn applies the same rule', async () => {
    const session = createSession('h2', () =>
      makeFakeQuery([[harnessResult(), msg('assistant'), resultMsg()]]),
    );
    const log: Burst = { starts: 0, ends: 0 };
    const pump = armIdle(session, burstCallbacks(log, 5));

    const seen: SDKMessage[] = [];
    await pump.startTurn(userTurn('answer'), (m) => {
      seen.push(m);
    });

    expect(seen.map((m) => m.type)).toEqual(['result', 'assistant', 'result']);
    expect((await pump.done).reason).toBe('turn-taken-over');
  });

  // The realign-after-handler-error path reads `result` as "already at the boundary" and skips the
  // drain. A harness result is NOT the boundary — our turn's frames are all still behind it — so
  // skipping there leaves them in the generator for the NEXT turn to inherit and misattribute.
  it('realigns past our own boundary when onMessage throws on a harness result', async () => {
    const session = createSession('h4', () =>
      makeFakeQuery([
        [harnessResult(), msg('assistant'), resultMsg()],
        [msg('assistant'), resultMsg()],
      ]),
    );

    await expect(
      runTurn(session, userTurn('a'), (m) => {
        if (m.type === 'result') throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(session.busy).toBe(false);

    // Turn 2 must see ONLY its own frames — turn 1's tail was drained, not left behind.
    const seen: string[] = [];
    await runTurn(session, userTurn('b'), (m) => {
      seen.push(m.type);
    });
    expect(seen).toEqual(['assistant', 'result']);
  });

  // A wake burst IS the harness's own turn, so its result is the one that closes the burst.
  // Filtering there would leave the pump mid-burst forever.
  it('a wake burst still closes on its own harness result', async () => {
    const session = createSession('h3', () => makeFakeQuery([[msg('assistant'), harnessResult()]]));
    const log: Burst = { starts: 0, ends: 0 };
    const pump = armIdle(session, burstCallbacks(log, 1));

    expect((await pump.done).reason).toBe('work-finished');
    expect(log.starts).toBe(1);
    expect(log.ends).toBe(1);
  });
});

describe('subagent task tracking at the frame chokepoint', () => {
  const publish = vi.fn();

  beforeEach(() => {
    __resetSessionsForTest();
    __resetSubagentTaskStatusForTest();
    publish.mockClear();
    setSubagentTaskPublisher(publish);
  });

  const taskStarted = (): SDKMessage =>
    msg('system', {
      subtype: 'task_started',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      subagent_type: 'general-purpose',
    });

  it('an ambient task_started at idle feeds the tracker and opens NO burst', async () => {
    const ch = channelQuery();
    const session = createSession('t1', () => ch.query);
    const log = { starts: 0 };
    const pump = armIdle(session, {
      onBurstStart: () => {
        log.starts += 1;
      },
      onMessage: () => {},
      onBurstEnd: () => {},
      onWaitOver: () => {},
      isWorkFinished: () => false,
    });

    ch.emit(taskStarted());
    await new Promise((r) => setTimeout(r, 0));

    // The burst-state invariant: ambient frames never open a burst, but the tracker saw the frame.
    expect(log.starts).toBe(0);
    expect(session.busy).toBe(true);
    expect(publish).toHaveBeenCalledWith({ subChatId: 't1', toolCallId: 'tool-1', running: true });

    ch.end();
    await pump.done;
  });

  it('endSession retracts tracked tasks', () => {
    const ch = channelQuery();
    createSession('t2', () => ch.query);
    noteSubagentTaskFrame('t2', taskStarted());
    publish.mockClear();

    endSession('t2');
    expect(publish).toHaveBeenCalledWith({ subChatId: 't2', toolCallId: 'tool-1', running: false });
  });

  it('unregisterSessionIfOwned retracts tracked tasks (the flow-disposal detach)', () => {
    const ch = channelQuery();
    const session = createSession('t3', () => ch.query);
    noteSubagentTaskFrame('t3', taskStarted());
    publish.mockClear();

    expect(unregisterSessionIfOwned(session)).toBe(true);
    expect(publish).toHaveBeenCalledWith({ subChatId: 't3', toolCallId: 'tool-1', running: false });
  });
});
