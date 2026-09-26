import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { getRuntimeTopologySnapshot } from '../../diagnostics/provider-topology';
import {
  __resetSessionsForTest,
  claimRetainedSession,
  endSession,
  createSession,
  getSession,
  isPumpAdoptRefusedError,
  releaseLeftoverSession,
  retainSession,
} from '../claude-session-registry';
import {
  __resetSubagentTaskStatusForTest,
  setSubagentTaskPublisher,
} from '../streaming/subagent-task-status';
import { armIdle, runTurn } from './claude-session-loop';
import type { WakePumpCallbacks } from './wake-pump-types';

// Replaced wholesale, not spread over the original: `sentry/init` imports `electron`, which cannot
// be loaded under vitest at all.
const captureMainMessage = vi.hoisted(() => vi.fn());
vi.mock('../../sentry/init', () => ({ captureMainException: vi.fn(), captureMainMessage }));

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

/** A `Query` the test feeds live, counting how many times the stream was actually pulled. */
function channelQuery(): {
  query: Query;
  emit: (m: SDKMessage) => void;
  end: () => void;
  reads: () => number;
} {
  const buffer: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let reads = 0;
  const release = (): void => {
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
  const stream = gen();
  const query = {
    next: () => {
      reads += 1;
      return stream.next();
    },
    // Ending the iterator kills the CLI, and its stream finishes with it — the lever both the
    // post-EOF reap and an explicit stop reach for once stdin is already closed.
    return: async () => {
      ended = true;
      release();
      return { done: true, value: undefined };
    },
    close: vi.fn(() => {
      ended = true;
      release();
    }),
  } as unknown as Query;
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
    reads: () => reads,
  };
}

type BurstLog = { starts: number; ends: number; waitOvers: number };
const newLog = (): BurstLog => ({ starts: 0, ends: 0, waitOvers: 0 });
const wakeCallbacks = (log: BurstLog, isWorkFinished = () => false): WakePumpCallbacks => ({
  onBurstStart: () => {
    log.starts += 1;
  },
  onMessage: () => {},
  onBurstEnd: () => {
    log.ends += 1;
  },
  onWaitOver: () => {
    log.waitOvers += 1;
  },
  isWorkFinished,
});

const ambient = (): SDKMessage => msg('system', { subtype: 'task_progress' });

describe('the session-lifetime reader', () => {
  beforeEach(() => {
    __resetSessionsForTest();
    __resetSubagentTaskStatusForTest();
    captureMainMessage.mockClear();
  });

  it('pulls nothing from the stream until a turn or a wake arming registers', async () => {
    const ch = channelQuery();
    const session = createSession('gap', () => ch.query);
    await new Promise((r) => setTimeout(r, 0));

    // The generator's own backpressure is the buffer between registrations: a frame the CLI writes
    // here waits in it, exactly as it did when each turn brought its own reader.
    expect(ch.reads()).toBe(0);

    const turn = runTurn(session, userTurn('hi'), () => {});
    await vi.waitFor(() => expect(ch.reads()).toBeGreaterThan(0));
    ch.emit(resultMsg());
    await turn;
  });

  it('resolves a turn only after its boundary frame has been handled', async () => {
    const ch = channelQuery();
    const session = createSession('boundary-order', () => ch.query);
    const order: string[] = [];

    const turn = runTurn(session, userTurn('hi'), async (m) => {
      if (m.type !== 'result') return;
      // The real sink persists and backfills here; resolving the caller first would let the
      // post-turn pipeline race the final chunk.
      await new Promise((r) => setTimeout(r, 5));
      order.push('handler');
    });
    ch.emit(resultMsg());
    await turn;
    order.push('caller');

    expect(order).toEqual(['handler', 'caller']);
  });

  it('owns the busy span of a turn: set on registration, cleared before the caller resumes', async () => {
    const ch = channelQuery();
    const session = createSession('busy-turn', () => ch.query);
    const busyDuringTurn: boolean[] = [];

    const turn = runTurn(session, userTurn('hi'), () => {
      busyDuringTurn.push(session.busy);
    });
    // Synchronous, because the executor's superseded-sibling check and runTurn's re-entry guard both
    // read it without awaiting anything first.
    expect(session.busy).toBe(true);
    const settled = session.turnSettled;
    expect(settled).not.toBeNull();

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await turn;

    expect(busyDuringTurn).toEqual([true, true]);
    expect(session.busy).toBe(false);
    // The executor's leftover branch waits on this handle before deciding the session is free.
    await settled;
    expect(session.turnSettled).toBeNull();
  });

  it('owns the busy span of a wake arming until the arming itself ends', async () => {
    const ch = channelQuery();
    const session = createSession('busy-arming', () => ch.query);
    const log = newLog();
    const arming = armIdle(session, wakeCallbacks(log));
    expect(session.busy).toBe(true);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(log.ends).toBe(1));
    expect(session.busy).toBe(true); // a finished burst is not a finished wait

    ch.end();
    expect((await arming.done).reason).toBe('stream-ended');
    expect(session.busy).toBe(false);
    expect(session.turnSettled).toBeNull();
  });

  it('lets a turn take a live arming over: the arming settles, the reader carries on', async () => {
    const ch = channelQuery();
    const session = createSession('takeover', () => ch.query);
    const log = newLog();
    const arming = armIdle(session, wakeCallbacks(log));

    const adopted: string[] = [];
    const taken = arming.startTurn(userTurn('follow-up'), (m) => {
      adopted.push(m.type);
    });
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await taken;

    // The hold this arming belongs to settles here — the loop, however, is still reading.
    expect(await arming.done).toEqual({ reason: 'turn-taken-over' });
    expect(adopted).toEqual(['assistant', 'result']);
    expect(log.starts).toBe(0); // nothing was attributed to a wake burst

    const next: string[] = [];
    const second = runTurn(session, userTurn('again'), (m) => {
      next.push(m.type);
    });
    ch.emit(resultMsg());
    await second;
    expect(next).toEqual(['result']);
  });

  it('refuses to adopt an arming that a sink error already ended, before any preparation runs', async () => {
    const ch = channelQuery();
    const session = createSession('sink-error-adopt', () => ch.query);
    const arming = armIdle(session, {
      onBurstStart: () => {
        throw new Error('burst bookkeeping failed');
      },
      onMessage: () => {},
      onBurstEnd: () => {},
      onWaitOver: () => {},
      isWorkFinished: () => false,
    });

    ch.emit(msg('assistant'));
    expect((await arming.done).reason).toBe('sink-error');
    // The live registration is gone but the reader survives — exactly the window where a
    // session-level dispatch would mistake this dead adoption target for a fresh turn.
    expect(session.busy).toBe(false);

    const beforePush = vi.fn();
    const rejection = await arming
      .startTurn(userTurn('adopt me'), () => {}, beforePush)
      .catch((err) => err);
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);
    expect(beforePush).not.toHaveBeenCalled();
  });

  it('releases a parked reader on reset, so a later turn fails loudly instead of hanging', async () => {
    const ch = channelQuery();
    const session = createSession('teardown', () => ch.query);

    __resetSessionsForTest();
    await new Promise((r) => setTimeout(r, 0));

    const rejection = await runTurn(session, userTurn('late'), () => {}).catch((err) => err);
    // Marked adopt-refused: with no reader, the caller's recovery is a fresh session.
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);
  });

  it('settles a wake arming at once when the reader has already gone', async () => {
    const ch = channelQuery();
    const session = createSession('arm-after-teardown', () => ch.query);

    __resetSessionsForTest();
    await new Promise((r) => setTimeout(r, 0));

    const arming = armIdle(session, wakeCallbacks(newLog()));
    // Left registered, this arming would never see a frame, so the hold behind it would hold its
    // flow lease and runtime slot until the process restarted.
    expect(await arming.done).toEqual({ reason: 'stream-ended' });
    expect(session.busy).toBe(false);
  });

  it('logs one turn-timing line per pushed turn, never for a wake burst', async () => {
    const info = vi.spyOn(log, 'info');
    const ch = channelQuery();
    const session = createSession('timing', () => ch.query);
    const fresh = runTurn(session, userTurn('go'), () => {});
    ch.emit(msg('system', { subtype: 'init' }));
    ch.emit(msg('stream_event', { event: { type: 'content_block_delta' } }));
    ch.emit(resultMsg());
    await fresh;

    const arming = armIdle(session, wakeCallbacks(newLog()));
    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    const adopted = arming.startTurn(userTurn('more'), () => {});
    ch.emit(resultMsg());
    await adopted;

    const lines = info.mock.calls.map(([line]) => String(line)).filter((l) => l.includes('timing'));
    info.mockRestore();
    expect(lines).toEqual([
      expect.stringMatching(
        /^\[Claude Session\] turn-timing sub=timing path=fresh spawnToInitMs=\d+ pushToInitMs=\d+ pushToFirstTokenMs=\d+ initFrame=yes$/,
      ),
      expect.stringMatching(
        /path=adopted spawnToInitMs=na pushToInitMs=na pushToFirstTokenMs=na initFrame=no$/,
      ),
    ]);
  });

  it('logs no turn-timing line for a turn whose push failed', async () => {
    const info = vi.spyOn(log, 'info');
    const session = createSession('unpushed', () => channelQuery().query);
    session.queue.close();
    await expect(runTurn(session, userTurn('go'), () => {})).rejects.toThrow('push after close');
    const lines = info.mock.calls.map(([line]) => String(line)).filter((l) => l.includes('timing'));
    info.mockRestore();
    expect(lines).toEqual([]);
  });
});

/**
 * The wait's liveness rule ends its ADVERTISEMENT and closes stdin; it never stops the reader. The
 * CLI writes complete queued turns for seconds after EOF, so a consumer that stopped there lost
 * whatever came next — measured in the field as the model's final answer reaching the CLI's own
 * transcript and never the chat. See decision `unattended-wake-budget`.
 */
describe('a wait that is over', () => {
  beforeEach(() => {
    __resetSessionsForTest();
    __resetSubagentTaskStatusForTest();
    captureMainMessage.mockClear();
  });

  it('orphans a draining leftover for a fresh turn, and the orphan still salvages to the end', async () => {
    const ch = channelQuery();
    const session = createSession('drain-orphan', () => ch.query);
    const log = newLog();
    const arming = armIdle(
      session,
      wakeCallbacks(log, () => true),
    );

    ch.emit(resultMsg());
    await vi.waitFor(() => expect(session.queue.closed).toBe(true));

    // The executor's leftover branch for a follow-up message: the registry slot frees for a fresh
    // session, but the drain is not killed with it.
    await releaseLeftoverSession('drain-orphan');
    expect(getSession('drain-orphan')).toBeUndefined();

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(log.ends).toBe(2)); // the orphaned reader still consumed the burst

    ch.end();
    expect((await arming.done).reason).toBe('work-finished');
  });

  it('refuses to adopt once the wait is over, so the caller retries on a fresh session', async () => {
    const ch = channelQuery();
    const session = createSession('drain-adopt', () => ch.query);
    const arming = armIdle(
      session,
      wakeCallbacks(newLog(), () => true),
    );

    ch.emit(resultMsg());
    await vi.waitFor(() => expect(session.queue.closed).toBe(true));

    // The hold was checked live before the latch landed — the sink is where the race is decided.
    const rejection = await arming.startTurn(userTurn('too late'), () => {}).catch((err) => err);
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);

    ch.end();
    expect((await arming.done).reason).toBe('work-finished');
  });

  it('settles the advertisement, closes stdin, and reads on to the stream’s real end', async () => {
    const ch = channelQuery();
    const session = createSession('drain', () => ch.query);
    const log = newLog();
    const arming = armIdle(
      session,
      wakeCallbacks(log, () => true),
    );

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(log.waitOvers).toBe(1));
    expect(session.queue.closed).toBe(true);
    // A follow-up arriving now must not wait on the drain: it takes the fresh-session path at once.
    expect(session.busy).toBe(false);
    expect(session.turnSettled).toBeNull();
    expect(arming.isEnded()).toBe(false);

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(log.ends).toBe(2));
    expect(log.starts).toBe(2);
    expect(log.waitOvers).toBe(1); // latched once per arming, whatever else arrives

    expect(captureMainMessage).toHaveBeenCalledWith(
      expect.stringContaining('after the wait ended'),
      'warning',
      expect.objectContaining({ surface: 'wake-pump-stand-down', subChatId: 'drain' }),
    );

    ch.end();
    expect(await arming.done).toEqual({ reason: 'work-finished', bursts: 2 });
  });

  it('cannot end on a burst that produced no result frame', async () => {
    const ch = channelQuery();
    const session = createSession('no-result', () => ch.query);
    const log = newLog();
    armIdle(
      session,
      wakeCallbacks(log, () => true),
    );

    // A burst parked on an approval or an unanswered question never reaches a result — which is
    // what makes it impossible to end a wait out from under a question the user has not seen.
    ch.emit(msg('assistant'));
    ch.emit(msg('tool-input-available'));
    await new Promise((r) => setTimeout(r, 0));

    expect(log.starts).toBe(1);
    expect(log.waitOvers).toBe(0);
    expect(session.queue.closed).toBe(false);
    ch.end();
  });

  it('retracts the subagent roster with the wait, not with the session', async () => {
    const publish = vi.fn();
    setSubagentTaskPublisher(publish);
    const ch = channelQuery();
    const session = createSession('roster', () => ch.query);
    const log = newLog();
    const arming = armIdle(
      session,
      wakeCallbacks(log, () => true),
    );

    ch.emit(
      msg('system', {
        subtype: 'task_started',
        task_id: 'a1',
        tool_use_id: 'tool-1',
        subagent_type: 'general-purpose',
      }),
    );
    ch.emit(resultMsg());

    // Left running, the roster spins over a chat the renderer already draws as finished.
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith({
        subChatId: 'roster',
        toolCallId: 'tool-1',
        running: false,
      }),
    );
    expect(arming.isEnded()).toBe(false);

    // A drain frame must not repopulate the roster: a fresh session for this chat may own it now.
    publish.mockClear();
    ch.emit(
      msg('system', {
        subtype: 'task_started',
        task_id: 'a2',
        tool_use_id: 'tool-2',
        subagent_type: 'general-purpose',
      }),
    );
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(log.ends).toBe(2));
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ running: true }));
    ch.end();
  });

  it('lets an explicit stop end the iterator, since closing stdin again would decide nothing', async () => {
    const ch = channelQuery();
    const session = createSession('stop-in-drain', () => ch.query);
    const arming = armIdle(
      session,
      wakeCallbacks(newLog(), () => true),
    );

    ch.emit(resultMsg());
    await vi.waitFor(() => expect(session.queue.closed).toBe(true));

    endSession('stop-in-drain'); // chat close, provider switch, app quit
    expect(await arming.done).toEqual({ reason: 'work-finished', bursts: 1 });
    expect(createSession('stop-in-drain', () => channelQuery().query)).not.toBe(session);
  });

  it('does not let a stream of ambient idle frames hold a wedged drain open', async () => {
    vi.useFakeTimers();
    try {
      const ch = channelQuery();
      const session = createSession('reap-ambient', () => ch.query);
      const arming = armIdle(
        session,
        wakeCallbacks(newLog(), () => true),
      );

      ch.emit(resultMsg());
      await vi.advanceTimersByTimeAsync(0);
      expect(session.queue.closed).toBe(true);

      // Chatter past the whole deadline: if ambient frames reset it, the reap would now be armed
      // for 60s AFTER the last heartbeat and this wait would outlive the assertion below.
      for (let i = 0; i < 7; i++) {
        ch.emit(ambient());
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await arming.done).toEqual({ reason: 'work-finished', bursts: 1 });
      expect(captureMainMessage).toHaveBeenCalledWith(
        expect.stringContaining('never exited'),
        'warning',
        expect.objectContaining({ surface: 'wake-pump-stand-down' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaps a CLI that never exits — after quiet only, and never out from under a burst', async () => {
    vi.useFakeTimers();
    try {
      const ch = channelQuery();
      const session = createSession('reap', () => ch.query);
      const log = newLog();
      const arming = armIdle(
        session,
        wakeCallbacks(log, () => true),
      );

      ch.emit(resultMsg());
      await vi.advanceTimersByTimeAsync(0);
      expect(session.queue.closed).toBe(true);

      // Heartbeats are not work. If they postponed the reap, a harness that chatters would keep a
      // wedged CLI — and the flow lease behind it — alive for as long as it kept talking.
      for (let i = 0; i < 5; i++) {
        ch.emit(ambient());
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(arming.isEnded()).toBe(false);

      // A real burst is: it restarts the quiet clock, and while it is open nothing may end it —
      // this is what keeps the reap from being the wait ceiling four decisions have rejected.
      ch.emit(msg('assistant'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(arming.isEnded()).toBe(false);
      expect(log.ends).toBe(1);

      ch.emit(resultMsg());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(await arming.done).toEqual({ reason: 'work-finished', bursts: 2 });
      expect(captureMainMessage).toHaveBeenCalledWith(
        expect.stringContaining('never exited'),
        'warning',
        expect.objectContaining({ surface: 'wake-pump-stand-down' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a session idling between turns', () => {
  let infoLog: MockInstance<typeof log.info>;
  beforeEach(() => {
    __resetSessionsForTest();
    infoLog = vi.spyOn(log, 'info');
  });
  afterEach(() => infoLog.mockRestore());

  let n = 0;
  const idle = () => {
    const ch = channelQuery();
    const session = createSession(`idle-${(n += 1)}`, () => ch.query);
    retainSession(session);
    return { ch, session };
  };
  const retireLines = () =>
    infoLog.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[Claude Session] retire'));

  it('is watched: the reader pulls its stream, and the topology counts it', async () => {
    const { ch } = idle();

    await vi.waitFor(() => expect(ch.reads()).toBe(1));
    expect(getRuntimeTopologySnapshot().claudeRetainedSessionCount).toBe(1);
  });

  it.each([
    ['rate_limit_event', msg('rate_limit_event')],
    ['commands_changed', msg('system', { subtype: 'commands_changed' })],
    ['notification', msg('system', { subtype: 'notification' })],
    ['state idle', msg('system', { subtype: 'session_state_changed', state: 'idle' })],
    ['task_progress', msg('system', { subtype: 'task_progress' })],
    ['memory_recall', msg('system', { subtype: 'memory_recall' })],
  ])('stays idle through %s', async (_, frame) => {
    const { ch, session } = idle();

    ch.emit(frame);

    await vi.waitFor(() => expect(ch.reads()).toBe(2));
    expect(session.retained).not.toBeNull();
    expect(getSession(session.subChatId)).toBe(session);
  });

  it.each([
    ['assistant', msg('assistant')],
    ['task_notification', msg('system', { subtype: 'task_notification' })],
    ['state running', msg('system', { subtype: 'session_state_changed', state: 'running' })],
  ])('is retired when the CLI starts a turn of its own (%s)', async (_, frame) => {
    const { ch, session } = idle();

    ch.emit(frame);

    await vi.waitFor(() => expect(getSession(session.subChatId)).toBeUndefined());
    expect(session.query.close).toHaveBeenCalledOnce();
    expect(retireLines()).toEqual([
      `[Claude Session] retire sub=${session.subChatId} reason=idle-activity`,
    ]);
  });

  it('is retired when its stream ends', async () => {
    const { ch, session } = idle();

    ch.end();

    await vi.waitFor(() => expect(getSession(session.subChatId)).toBeUndefined());
    expect(session.loop.exited).toBe(true);
    expect(retireLines()).toEqual([
      `[Claude Session] retire sub=${session.subChatId} reason=stream-ended`,
    ]);
  });

  it('parks in the gap after a turn, so a post-result wake still reaches a wake arming', async () => {
    const ch = channelQuery();
    const session = createSession('post-result', () => ch.query);
    const turn = runTurn(session, userTurn('hi'), () => {});
    ch.emit(resultMsg());
    await turn;
    const reads = ch.reads();

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ch.reads()).toBe(reads);

    const wakes = newLog();
    armIdle(session, wakeCallbacks(wakes));
    await vi.waitFor(() => expect(wakes.ends).toBe(1));
  });
});

describe('a claimed turn prepares under busy before its push', () => {
  beforeEach(() => __resetSessionsForTest());

  /** An idle session a send has just claimed: its reader is already watching the stream. */
  const claimed = (id: string) => {
    const ch = channelQuery();
    const session = createSession(id, () => ch.query, { sdkSessionId: 's' });
    retainSession(session);
    claimRetainedSession(id, { keyParts: {}, persistedSessionId: 's', flowTurn: false });
    return { ch, session };
  };
  const accept = async () => true;
  const prompts = (session: ReturnType<typeof createSession>) => {
    const pushed: unknown[] = [];
    const push = session.queue.push.bind(session.queue);
    session.queue.push = (message) => {
      pushed.push(message);
      push(message);
    };
    return pushed;
  };

  it('pushes once beforePush resolves, holding busy meanwhile', async () => {
    const { ch, session } = claimed('prep');
    const pushed = prompts(session);
    let ready = () => {};
    const turn = runTurn(
      session,
      userTurn('hi'),
      () => {},
      () => new Promise<boolean>((resolve) => (ready = () => resolve(true))),
    );

    expect(session.busy).toBe(true);
    expect(pushed).toHaveLength(0);
    ch.emit(msg('system', { subtype: 'task_progress' }));
    ready();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    ch.emit(resultMsg());
    await turn;
  });

  it.each([
    ['a result', resultMsg()],
    ['model output', msg('assistant')],
  ])('%s, from a turn the CLI was already running, refuses the claim', async (label, frame) => {
    const { ch, session } = claimed(`prep-busy-${label}`);
    const pushed = prompts(session);
    const seen: SDKMessage[] = [];
    let ready = () => {};
    const turn = runTurn(
      session,
      userTurn('hi'),
      (m) => void seen.push(m),
      () => new Promise<boolean>((resolve) => (ready = () => resolve(true))),
    ).catch((err: unknown) => err);

    ch.emit(frame);
    const outcome = await turn;
    ready();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isPumpAdoptRefusedError(outcome)).toBe(true);
    expect(pushed).toHaveLength(0);
    expect(seen).toHaveLength(0);
    // Closing stdin would let that turn run on, acting for the claimer: the CLI is force-closed.
    expect(session.query.close).toHaveBeenCalledOnce();
    expect(getSession(session.subChatId)).toBeUndefined();
  });

  it('a refused beforePush ends the turn adopt-refused with nothing pushed', async () => {
    const { session } = claimed('prep-refused');
    const pushed = prompts(session);

    const outcome = await runTurn(
      session,
      userTurn('hi'),
      () => {},
      async () => false,
    ).catch((err: unknown) => err);

    expect(isPumpAdoptRefusedError(outcome)).toBe(true);
    expect(pushed).toHaveLength(0);
    expect(session.busy).toBe(false);
  });

  it('a stream that ends while beforePush awaits ends the turn, and nothing is pushed after', async () => {
    const { ch, session } = claimed('prep-dead');
    const pushed = prompts(session);
    let ready = () => {};
    const turn = runTurn(
      session,
      userTurn('hi'),
      () => {},
      () => new Promise<boolean>((resolve) => (ready = () => resolve(true))),
    ).catch((err: unknown) => err);

    ch.end();
    const outcome = await turn;
    ready();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isPumpAdoptRefusedError(outcome)).toBe(true);
    expect(pushed).toHaveLength(0);
  });

  it('a claimed CLI that dies after the push, before the model says anything, is adopt-refused', async () => {
    const { ch, session } = claimed('died-unserved');
    const pushed = prompts(session);
    const turn = runTurn(session, userTurn('hi'), () => {}, accept).catch((e: unknown) => e);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));

    ch.emit(msg('system', { subtype: 'init' }));
    ch.end();

    expect(isPumpAdoptRefusedError(await turn)).toBe(true);
  });

  it.each([
    ['its handler throws', false],
    ['its CLI dies after the model spoke', true],
  ])('a claimed turn whose %s keeps its own error: it already ran', async (_, dies) => {
    const { ch, session } = claimed(`served-${dies}`);
    const pushed = prompts(session);
    const onMessage = () => {
      if (!dies) throw new Error('handler failed');
    };
    const turn = runTurn(session, userTurn('hi'), onMessage, accept).catch((e: unknown) => e);
    await vi.waitFor(() => expect(pushed).toHaveLength(1));

    ch.emit(msg('assistant'));
    if (dies) ch.end();
    else ch.emit(resultMsg());

    const outcome = await turn;
    expect(outcome).toBeInstanceOf(Error);
    expect(isPumpAdoptRefusedError(outcome)).toBe(false);
  });
});
