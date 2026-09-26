import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../claude', () => ({
  // Wake bursts each create a transformer; identity mapping keeps assertions simple.
  createTransformer: () =>
    function* (m: unknown) {
      yield m as never;
    },
}));
vi.mock('../trpc/routers/frink-task-signal-persist', () => ({
  markLinkedTaskQuietEnd: vi.fn(async () => true),
  persistLinkedTaskSignal: vi.fn(async () => true),
}));
const captureMainException = vi.hoisted(() => vi.fn());
const captureMainMessage = vi.hoisted(() => vi.fn());
vi.mock('../sentry/init', () => ({ captureMainException, captureMainMessage }));
// Pulled in by plan-auto-approve (adoptedTurnBeforePush); nothing in these tests touches the DB.
vi.mock('../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../db/repos/sub-chats', () => ({ updateSubChatMode: vi.fn(async () => {}) }));

import type { TaskSignalPayload } from '../../../shared/types/task-signal';
import { pendingToolApprovals } from '../claude/ask-user-question-approval';
import type { TaskStopHook } from '../task-stop-hook';
import { persistLinkedTaskSignal } from '../trpc/routers/frink-task-signal-persist';
import {
  __resetSessionsForTest,
  type ClaudeSession,
  endSession,
  createSession,
  getSession,
  isPumpAdoptRefusedError,
  retainSession,
} from './claude-session-registry';
import { createClaudeTurnContext } from './claude-turn-context';
import {
  armWakePump,
  hasWakeHold,
  releaseNonFlowClaudeSessions,
  releaseWakeHold,
  takeWakeHold,
  type WakeHoldIo,
} from './claude-wake-hold';
import { hasReusableWakeHoldRuntimeSlot, listWakeHolds } from './execution/wake-hold-registry-view';
import { declaresWaitOver } from './execution/wake-hold-signal';
import { adoptedTurnBeforePush } from './streaming/plan-auto-approve';

beforeEach(() => {
  captureMainException.mockClear();
});

const msg = (type: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type, ...extra }) as unknown as SDKMessage;

/** The terminal frame of a wake burst — where the wait's liveness rule is evaluated. */
const resultMsg = (extra: Record<string, unknown> = {}): SDKMessage =>
  msg('result', { subtype: 'success', total_cost_usd: 0, ...extra });

/** A `Query` the test feeds live — mirrors claude-session-registry.test.ts's channelQuery. */
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
  const query = Object.assign(gen(), {
    interrupt: async () => {
      ended = true;
      release();
    },
  }) as unknown as Query;
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

const noopIo = (): WakeHoldIo => ({
  streamChunk: vi.fn(),
  emitPlanCard: vi.fn(async () => {}),
  completeBurst: vi.fn(),
  setHeld: vi.fn(),
  clearPendingApprovals: vi.fn(),
  getLatestTaskSignal: vi.fn(() => null),
  clearCurrentExecutionChat: vi.fn(),
});

/** The held-state values published to the renderer, in order. */
const heldCalls = (io: WakeHoldIo): boolean[] =>
  (io.setHeld as unknown as { mock: { calls: [boolean][] } }).mock.calls.map(([held]) => held);

const pendingWork = {
  backgroundTasks: [{ id: 'bg1', type: 'shell', status: 'running', description: 'coverage' }],
  sessionCrons: [],
} as never;

/**
 * The arming turn a hold extends. `chunks` starts with the turn's own content so tests can tell a
 * merged snapshot (arming + burst) from a burst-only one — the bug being guarded is a burst
 * replacing the message it was supposed to append to.
 */
const ARMING_MSG_ID = 'arming-msg';
const ARMING_CHUNK_COUNT = 3;
function withArmingTurn(session: ClaudeSession): ClaudeSession {
  let index = 7; // mid-turn, so a burst restarting at 0 is visible in assertions
  // Augments the turn a test already set up (e.g. with an Auto grant) rather than replacing it.
  const turn = session.currentTurn ?? createClaudeTurnContext();
  turn.msgId = ARMING_MSG_ID;
  turn.lastCollectedChunks = [
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: 'arming turn said this' },
    { type: 'text-end', id: 't0' },
  ];
  turn.nextMessageIndex = () => index++;
  session.currentTurn = turn;
  return session;
}

/** A hold with no Flow resource ownership — the ordinary chat case. */
const armChatHold = (subChatId: string) => {
  const ch = channelQuery();
  const session = createSession(subChatId, () => ch.query);
  const io = noopIo();
  armWakePump({
    session: withArmingTurn(session),
    pendingWork,
    subChatId,
    executionContextId: undefined,
    signalTaskId: null,
    io,
  });
  return { ch, session, io };
};

/** A hold carrying the Flow resource ownership the arming execute transferred to it. */
const armFlowHold = (subChatId: string, canClearPendingApprovals?: () => boolean) => {
  const ch = channelQuery();
  const session = createSession(subChatId, () => ch.query);
  const io = noopIo();
  const releaseFlowResourceActivity = vi.fn();
  const releaseRuntimeSlot = vi.fn();
  const unregisterFlowRunAbort = vi.fn();
  armWakePump({
    session: withArmingTurn(session),
    pendingWork,
    subChatId,
    executionContextId: `ctx-${subChatId}`,
    signalTaskId: null,
    releaseFlowResourceActivity,
    releaseRuntimeSlot,
    unregisterFlowRunAbort,
    canClearPendingApprovals,
    io,
  });
  return {
    ch,
    session,
    io,
    releaseFlowResourceActivity,
    releaseRuntimeSlot,
    unregisterFlowRunAbort,
  };
};

describe('claude-wake-hold — disposal identity guards (ABA)', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  it('handles cancellation persistence rejection before hold classification', async () => {
    const missingError = new Error('missing hold persistence failed');
    const missingHoldPersistence = Promise.reject(missingError);
    const missingCatch = vi.spyOn(missingHoldPersistence, 'catch');

    releaseWakeHold('missing-hold', 'test-missing-hold', missingHoldPersistence);

    expect(missingCatch).toHaveBeenCalledOnce();

    const ch = channelQuery();
    const session = createSession('ordinary-hold', () => ch.query);
    armWakePump({
      session: withArmingTurn(session),
      pendingWork,
      subChatId: 'ordinary-hold',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });
    const ordinaryError = new Error('ordinary persistence failed');
    const ordinaryHoldPersistence = Promise.reject(ordinaryError);
    const ordinaryCatch = vi.spyOn(ordinaryHoldPersistence, 'catch');

    releaseWakeHold('ordinary-hold', 'test-ordinary-hold', ordinaryHoldPersistence);

    expect(ordinaryCatch).toHaveBeenCalledOnce();
    ch.end();
    await Promise.allSettled([missingHoldPersistence, ordinaryHoldPersistence]);
    expect(captureMainException).toHaveBeenCalledWith(missingError, {
      surface: 'claude-wake-hold',
      stage: 'cancellation-persist',
    });
    expect(captureMainException).toHaveBeenCalledWith(ordinaryError, {
      surface: 'claude-wake-hold',
      stage: 'cancellation-persist',
    });
  });

  it("an orphaned pump's done handler never tears down a NEWER session under the same key", async () => {
    const chA = channelQuery();
    const held = createSession('w1', () => chA.query);
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w1',
      executionContextId: 'ctx-w1',
      signalTaskId: null,
      io,
    });

    // A plan-mode (or fresh) execute disposes the held session and registers a successor
    // under the same subChatId while the orphaned pump's cleanup is still in flight.
    endSession('w1');
    const chB = channelQuery();
    const successor = createSession('w1', () => chB.query);

    chA.end(); // the orphaned pump now observes its stream death and runs cleanup
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The successor survived: the done handler's disposal is identity-guarded — including the
    // pending approvals, which are keyed by subChatId and now belong to the successor's turn.
    expect(getSession('w1')).toBe(successor);
    expect(successor.queue.closed).toBe(false);
    expect(hasWakeHold('w1')).toBe(false);
    expect(io.clearPendingApprovals).not.toHaveBeenCalled();
    // The arming MCP context is per-execute — the dead pump still releases its own mapping.
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-w1');
  });

  it('takeover refuses a stale hold instead of pairing its pump with an ABA successor session', () => {
    const staleChannel = channelQuery();
    const stale = createSession('w1-take-aba', () => staleChannel.query);
    armWakePump({
      session: withArmingTurn(stale),
      pendingWork,
      subChatId: 'w1-take-aba',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    endSession('w1-take-aba');
    const successorChannel = channelQuery();
    const successor = createSession('w1-take-aba', () => successorChannel.query);

    expect(takeWakeHold('w1-take-aba')).toBeUndefined();
    expect(getSession('w1-take-aba')).toBe(successor);
    expect(successor.queue.closed).toBe(false);

    staleChannel.end();
    successorChannel.end();
  });

  it("a live pump's stream death clears the session's pending approvals (normal disposal)", async () => {
    const ch = channelQuery();
    const held = createSession('w5', () => ch.query);
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w5',
      executionContextId: 'ctx-w5',
      signalTaskId: null,
      io,
    });

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(getSession('w5')).toBeUndefined();
    expect(io.clearPendingApprovals).toHaveBeenCalledWith('Background wait ended.', 'w5');
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-w5');
  });

  it('finishes the transferred execution barrier only after wake cleanup settles', async () => {
    const ch = channelQuery();
    const held = createSession('w-settlement', () => ch.query);
    const io = noopIo();
    let cleanupFinished = false;
    vi.mocked(io.clearCurrentExecutionChat).mockImplementation(() => {
      cleanupFinished = true;
    });
    const wait = vi.fn(async () => {});
    const finish = vi.fn();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w-settlement',
      executionContextId: 'ctx-settlement',
      signalTaskId: null,
      executionSettlement: { wait, retain: () => ({ wait, finish }), finish: vi.fn() },
      io,
    });

    ch.emit(msg('assistant', { message: { content: [] } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(held.currentTurn?.waitForExecutionSettlement).toBe(wait);
    expect(finish).not.toHaveBeenCalled();

    ch.end();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith());
    expect(cleanupFinished).toBe(true);
  });

  it('releaseWakeHold on a stale hold drops the entry without killing the successor session', () => {
    const chA = channelQuery();
    const held = createSession('w2', () => chA.query);
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w2',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    endSession('w2');
    const chB = channelQuery();
    const successor = createSession('w2', () => chB.query);

    releaseWakeHold('w2', 'test-stale-release');
    expect(getSession('w2')).toBe(successor);
    expect(successor.queue.closed).toBe(false);
    expect(hasWakeHold('w2')).toBe(false);
    chA.end();
    chB.end();
  });

  it('a denied wake-burst tool gets a synthetic tool-output-error before the burst finalizes', async () => {
    const ch = channelQuery();
    const held = createSession('w4', () => ch.query);
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w4',
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

    // Wake burst: a tool call whose PreToolUse denial (recorded on the burst's turn context by
    // the session's hook closures) never gets a tool_result from the SDK.
    ch.emit(msg('tool-input-available', { toolCallId: 'denied-1', toolName: 'Bash' }));
    await new Promise((r) => setTimeout(r, 0));
    held.currentTurn?.deniedToolIdsWithMessages.set('denied-1', 'Denied by policy.');
    ch.emit(msg('result'));
    await new Promise((r) => setTimeout(r, 0));

    const completed = vi.mocked(io.completeBurst).mock.calls[0];
    expect(completed).toBeDefined();
    const chunks = completed?.[1] as Array<{ type: string; toolCallId?: string }>;
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-output-error',
        toolCallId: 'denied-1',
        permissionDenied: true,
      }),
    );
    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  it.each([true, false])(
    'a wake burst inherits the arming turn Auto grant (%s)',
    async (autoReviewTools) => {
      // The SDK query is still in the arming turn's permissionMode — only an ADOPTING turn resets
      // it — so a burst context defaulting to false would make Frink's own PreToolUse hook prompt
      // for approval on work the user already granted Auto for, with no one watching.
      const ch = channelQuery();
      const held = createSession('w-auto', () => ch.query);
      const armingTurn = createClaudeTurnContext();
      armingTurn.autoReviewTools = autoReviewTools;
      held.currentTurn = armingTurn;
      armWakePump({
        session: withArmingTurn(held),
        pendingWork,
        subChatId: 'w-auto',
        executionContextId: undefined,
        signalTaskId: null,
        io: noopIo(),
      });

      ch.emit(msg('tool-input-available', { toolCallId: 'burst-1', toolName: 'Bash' }));
      await new Promise((r) => setTimeout(r, 0));

      expect(held.currentTurn?.autoReviewTools).toBe(autoReviewTools);
      ch.end();
      await new Promise((r) => setTimeout(r, 0));
    },
  );

  it('a wake burst inherits the arming turn plan locks and knows it is a burst', async () => {
    // A plan-DRAFTING wait's bursts must keep terminals refused (turnOwesTerminalSignal reads the
    // live lock) and plan transitions denied — a fresh context defaulting the lock false would let
    // an unattended burst record a terminal signal or lift SDK plan restrictions. See decision
    // flow-quiet-wait-handling.
    const ch = channelQuery();
    const held = createSession('w-plan', () => ch.query);
    const armingTurn = createClaudeTurnContext();
    armingTurn.planTerminalsLocked = true;
    armingTurn.planAutoReview = true;
    const halt = () => false;
    armingTurn.planSubmissionHalt = halt;
    held.currentTurn = armingTurn;
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w-plan',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    ch.emit(msg('assistant'));
    await new Promise((r) => setTimeout(r, 0));

    expect(held.currentTurn).not.toBe(armingTurn);
    expect(held.currentTurn?.planTerminalsLocked).toBe(true);
    expect(held.currentTurn?.planSubmitted).toBe(false);
    expect(held.currentTurn?.planSubmissionHalt).toBe(halt);
    // The deny-floor gates on the ACTIVE turn's eligibility, so a burst must carry it too.
    expect(held.currentTurn?.planAutoReview).toBe(true);
    expect(held.currentTurn?.isWakeBurst).toBe(true);
    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('releaseWakeHold on a LIVE hold ends its own session (the normal stop path)', async () => {
    const ch = channelQuery();
    // Reports work, so the release logs what its stdin close drops (logDroppedPendingWork).
    const stopHook = Object.assign(async () => ({}), {
      reset: () => {},
      lastPendingWork: pendingWork,
    });
    const held = createSession('w3', () => ch.query, { stopHook });
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w3',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    releaseWakeHold('w3', 'test-live-release');
    expect(held.queue.closed).toBe(true);
    expect(getSession('w3')).toBeUndefined();
    ch.end(); // CLI exits after stdin close; the pump settles
    await new Promise((r) => setTimeout(r, 0));
    expect(hasWakeHold('w3')).toBe(false);
  });

  it('takeWakeHold refuses a hold whose pump already exited (cleanup still in flight)', async () => {
    const ch = channelQuery();
    const held = createSession('w4', () => ch.query);
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w4',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    // The pump observes its stream death; poll microtasks until its finish() ran (busy flips
    // false synchronously there). FIFO ordering puts this continuation BEFORE the done-handler
    // cleanup, so the dead hold is still registered — the window an adopting execute can hit.
    ch.end();
    for (let i = 0; i < 50 && held.busy; i++) await Promise.resolve();
    expect(held.busy).toBe(false);
    expect(hasWakeHold('w4')).toBe(true);

    // Adopting it would push into a queue with no reader and hang the turn forever.
    expect(takeWakeHold('w4')).toBeUndefined();
    expect(hasWakeHold('w4')).toBe(false);
  });

  it('a question held into the wait survives arming and is retired when a follow-up adopts', async () => {
    const resolve = vi.fn(() => true);
    pendingToolApprovals.set('ask-held', { subChatId: 'w5', resolve });
    const ch = channelQuery();
    const held = createSession('w5', () => ch.query);
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'w5',
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });

    // Arming a hold must not disturb the approval — the session (and the question) stay live.
    expect(pendingToolApprovals.has('ask-held')).toBe(true);

    // A follow-up adopts the hold: the reply supersedes the question, and this seam is the only
    // one that runs (no disposal — 'turn-taken-over'; no supersede clear — no activeExecutions
    // entry), so it must resolve the approval itself.
    expect(takeWakeHold('w5')).toBeDefined();
    expect(resolve).toHaveBeenCalledWith({ approved: false, message: 'Continued by your reply.' });
    expect(pendingToolApprovals.has('ask-held')).toBe(false);

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('claude-wake-hold — Flow resource ownership', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  it('releases after normal pump and MCP cleanup', async () => {
    const { ch, io, releaseFlowResourceActivity, releaseRuntimeSlot, unregisterFlowRunAbort } =
      armFlowHold('flow-normal');

    ch.end();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-normal');
    expect(vi.mocked(io.clearCurrentExecutionChat).mock.invocationCallOrder[0]).toBeLessThan(
      releaseRuntimeSlot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(releaseRuntimeSlot.mock.invocationCallOrder[0]).toBeLessThan(
      unregisterFlowRunAbort.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(unregisterFlowRunAbort.mock.invocationCallOrder[0]).toBeLessThan(
      releaseFlowResourceActivity.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(releaseRuntimeSlot).toHaveBeenCalledTimes(1);
    expect(unregisterFlowRunAbort).toHaveBeenCalledTimes(1);
    expect(releaseFlowResourceActivity).toHaveBeenCalledTimes(1);
  });

  it('releases exactly once after Stop closes and settles the provider', async () => {
    const { ch, session, releaseFlowResourceActivity, releaseRuntimeSlot } =
      armFlowHold('flow-stop');
    let persistCancellation = () => {};
    const cancellationPersistence = new Promise<void>((resolve) => {
      persistCancellation = resolve;
    });

    releaseWakeHold('flow-stop', 'test-stop', cancellationPersistence);
    expect(session.queue.closed).toBe(true);
    ch.end();
    await Promise.resolve();
    expect(releaseFlowResourceActivity).not.toHaveBeenCalled();
    persistCancellation();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(releaseRuntimeSlot).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeSlot.mock.invocationCallOrder[0]).toBeLessThan(
      releaseFlowResourceActivity.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(releaseFlowResourceActivity).toHaveBeenCalledTimes(1);
  });

  it('bypasses a Flow hold for an ordinary successor, then allows an active Flow takeover', async () => {
    const bypassed = armFlowHold('flow-bypass');
    expect(takeWakeHold('flow-bypass')).toBeUndefined();
    expect(bypassed.session.queue.closed).toBe(true);
    bypassed.ch.end();
    await vi.waitFor(() =>
      expect(bypassed.releaseFlowResourceActivity).toHaveBeenCalledWith(undefined),
    );

    const { ch, io, releaseFlowResourceActivity, releaseRuntimeSlot } =
      armFlowHold('flow-takeover');

    const hold = takeWakeHold('flow-takeover', true);
    const taken = hold?.pump.startTurn({ type: 'user' } as never, () => {});
    await Promise.resolve();
    ch.emit(resultMsg());
    await taken;

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(releaseRuntimeSlot).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeSlot.mock.invocationCallOrder[0]).toBeLessThan(
      releaseFlowResourceActivity.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(releaseFlowResourceActivity).toHaveBeenCalledTimes(1);
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-takeover');
    expect(getSession('flow-takeover')).toBeDefined();
    ch.end();
  });

  it('exposes and transfers the exact held runtime slot to a Flow successor', async () => {
    const { ch, releaseFlowResourceActivity, releaseRuntimeSlot } =
      armFlowHold('flow-slot-transfer');

    expect(hasReusableWakeHoldRuntimeSlot('flow-slot-transfer')).toBe(true);
    const hold = takeWakeHold('flow-slot-transfer', true);
    expect(hold).toBeDefined();
    expect(hasReusableWakeHoldRuntimeSlot('flow-slot-transfer')).toBe(false);

    const inheritedRuntimeSlotRelease = hold?.releaseRuntimeSlot;
    if (hold) hold.releaseRuntimeSlot = undefined;
    const taken = hold?.pump.startTurn({ type: 'user' } as never, () => {});
    await Promise.resolve();
    ch.emit(resultMsg());
    await taken;

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(releaseRuntimeSlot).not.toHaveBeenCalled();

    inheritedRuntimeSlotRelease?.();
    expect(releaseRuntimeSlot).toHaveBeenCalledOnce();
    ch.end();
  });

  it('does not poison old hold cleanup when the adopting foreground turn fails', async () => {
    const { ch, session, releaseFlowResourceActivity, releaseRuntimeSlot } =
      armFlowHold('flow-turn-error');
    const hold = takeWakeHold('flow-turn-error', true);
    const inheritedRuntimeSlotRelease = hold?.releaseRuntimeSlot;
    if (hold) hold.releaseRuntimeSlot = undefined;
    const turnError = new Error('foreground message handling failed');
    const taken = hold?.pump.startTurn({ type: 'user' } as never, () => {
      throw turnError;
    });

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());

    await expect(taken).rejects.toBe(turnError);
    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(releaseRuntimeSlot).not.toHaveBeenCalled();
    expect(getSession('flow-turn-error')).toBe(session);

    inheritedRuntimeSlotRelease?.();
    endSession('flow-turn-error');
    ch.end();
  });

  it('reports provider teardown failure through the activity token', async () => {
    const { ch, session, io, releaseFlowResourceActivity } = armFlowHold('flow-cleanup-error');
    const cleanupError = new Error('query return failed');
    session.query.return = vi.fn(async () => {
      throw cleanupError;
    });

    ch.end();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(cleanupError));
    expect(captureMainException).toHaveBeenCalledWith(cleanupError, {
      surface: 'claude-wake-hold',
      stage: 'cleanup',
    });
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-cleanup-error');
  });

  it('normalizes an undefined provider teardown rejection before activity release', async () => {
    const { ch, session, releaseFlowResourceActivity } = armFlowHold(
      'flow-undefined-cleanup-error',
    );
    session.query.return = vi.fn(async () => {
      throw undefined;
    });

    ch.end();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledOnce());
    expect(releaseFlowResourceActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Wake hold cleanup failed without an error value' }),
    );
  });

  it('still clears the exact MCP context when approval cleanup fails', async () => {
    const { ch, io, releaseFlowResourceActivity } = armFlowHold('flow-approval-error');
    const approvalError = new Error('approval cleanup failed');
    vi.mocked(io.clearPendingApprovals).mockImplementationOnce(() => {
      throw approvalError;
    });

    ch.end();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(approvalError));
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-approval-error');
  });

  it('reports durable cancellation failure through the activity token after provider cleanup', async () => {
    const { ch, releaseFlowResourceActivity, releaseRuntimeSlot } =
      armFlowHold('flow-cancellation-error');
    const cancellationError = new Error('task cancellation failed');

    releaseWakeHold(
      'flow-cancellation-error',
      'test-cancellation-error',
      Promise.reject(cancellationError),
    );
    ch.end();

    await vi.waitFor(() =>
      expect(releaseFlowResourceActivity).toHaveBeenCalledWith(cancellationError),
    );
    expect(releaseRuntimeSlot).toHaveBeenCalledOnce();
  });

  it('reports wake-burst persistence failure through the activity token', async () => {
    const ch = channelQuery();
    const session = createSession('flow-burst-persist-error', () => ch.query);
    const io = noopIo();
    vi.mocked(io.getLatestTaskSignal)
      .mockReturnValueOnce(null)
      .mockReturnValue({ at: '2026-08-01T12:00:00Z' } as never);
    const persistenceError = new Error('signal write failed');
    vi.mocked(persistLinkedTaskSignal).mockRejectedValueOnce(persistenceError);
    const releaseFlowResourceActivity = vi.fn();
    const releaseRuntimeSlot = vi.fn();
    armWakePump({
      session: withArmingTurn(session),
      pendingWork,
      subChatId: 'flow-burst-persist-error',
      executionContextId: 'ctx-flow-burst-persist-error',
      signalTaskId: 'task-flow-burst-persist-error',
      releaseFlowResourceActivity,
      releaseRuntimeSlot,
      io,
    });

    ch.emit(resultMsg());

    await vi.waitFor(() =>
      expect(releaseFlowResourceActivity).toHaveBeenCalledWith(persistenceError),
    );
    expect(releaseRuntimeSlot).toHaveBeenCalledOnce();
  });

  it('re-checks session ownership after awaited provider cleanup before clearing approvals', async () => {
    const { ch, session, io, releaseFlowResourceActivity } = armFlowHold('flow-cleanup-aba');
    let finishProviderCleanup = () => {};
    const providerCleanup = new Promise<void>((resolve) => {
      finishProviderCleanup = resolve;
    });
    session.query.return = vi.fn(async () => {
      await providerCleanup;
      return undefined as never;
    });

    ch.end();
    await vi.waitFor(() => expect(session.query.return).toHaveBeenCalled());
    const successorChannel = channelQuery();
    const successor = createSession('flow-cleanup-aba', () => successorChannel.query);
    finishProviderCleanup();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(getSession('flow-cleanup-aba')).toBe(successor);
    expect(successor.queue.closed).toBe(false);
    expect(io.clearPendingApprovals).not.toHaveBeenCalled();
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-cleanup-aba');

    endSession('flow-cleanup-aba');
    successorChannel.end();
  });

  it('keeps provider cleanup discoverable so a late Stop persists before release', async () => {
    const { ch, session, releaseFlowResourceActivity } = armFlowHold('flow-late-stop');
    let finishProviderCleanup = () => {};
    const providerCleanup = new Promise<void>((resolve) => {
      finishProviderCleanup = resolve;
    });
    session.query.return = vi.fn(async () => {
      await providerCleanup;
      return undefined as never;
    });
    let finishCancellation = () => {};
    const cancellationPersistence = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });

    ch.end();
    await vi.waitFor(() => expect(session.query.return).toHaveBeenCalled());
    expect(hasWakeHold('flow-late-stop')).toBe(true);
    releaseWakeHold('flow-late-stop', 'late-stop', cancellationPersistence);
    finishProviderCleanup();
    await Promise.resolve();
    expect(releaseFlowResourceActivity).not.toHaveBeenCalled();

    finishCancellation();
    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(hasWakeHold('flow-late-stop')).toBe(false);
  });

  it('drains a later Stop even when an earlier cancellation persistence rejects', async () => {
    const { ch, session, releaseFlowResourceActivity } = armFlowHold('flow-stop-error-race');
    let finishProviderCleanup = () => {};
    const providerCleanup = new Promise<void>((resolve) => {
      finishProviderCleanup = resolve;
    });
    session.query.return = vi.fn(async () => {
      await providerCleanup;
      return undefined as never;
    });
    let rejectFirstCancellation = (_error: Error) => {};
    const firstCancellation = new Promise<void>((_resolve, reject) => {
      rejectFirstCancellation = reject;
    });
    let finishSecondCancellation = () => {};
    const secondCancellation = new Promise<void>((resolve) => {
      finishSecondCancellation = resolve;
    });
    const firstError = new Error('first cancellation failed');

    ch.end();
    await vi.waitFor(() => expect(session.query.return).toHaveBeenCalled());
    releaseWakeHold('flow-stop-error-race', 'first-stop', firstCancellation);
    finishProviderCleanup();
    await Promise.resolve();
    releaseWakeHold('flow-stop-error-race', 'second-stop', secondCancellation);
    rejectFirstCancellation(firstError);
    await Promise.resolve();
    expect(releaseFlowResourceActivity).not.toHaveBeenCalled();

    finishSecondCancellation();
    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(firstError));
  });

  it('does not clear a non-Claude successor approval owner after provider cleanup awaits', async () => {
    let approvalOwnerIsCurrent = true;
    const { ch, session, io, releaseFlowResourceActivity } = armFlowHold(
      'flow-cross-provider-aba',
      () => approvalOwnerIsCurrent,
    );
    let finishProviderCleanup = () => {};
    const providerCleanup = new Promise<void>((resolve) => {
      finishProviderCleanup = resolve;
    });
    session.query.return = vi.fn(async () => {
      await providerCleanup;
      return undefined as never;
    });

    ch.end();
    await vi.waitFor(() => expect(session.query.return).toHaveBeenCalled());
    approvalOwnerIsCurrent = false;
    finishProviderCleanup();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(undefined));
    expect(getSession('flow-cross-provider-aba')).toBeUndefined();
    expect(io.clearPendingApprovals).not.toHaveBeenCalled();
    expect(io.clearCurrentExecutionChat).toHaveBeenCalledWith('ctx-flow-cross-provider-aba');
  });
});

describe('claude-wake-hold — burst streaming', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  it('ships a cumulative parts snapshot with each chunk', async () => {
    const ch = channelQuery();
    const held = createSession('b3', () => ch.query);
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'b3',
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

    ch.emit(msg('text-delta', { delta: 'one ' }));
    ch.emit(msg('text-delta', { delta: 'two' }));
    await new Promise((r) => setTimeout(r, 0));

    // Accumulated incrementally, not re-walked per chunk — the snapshot still has to be complete,
    // and it spans the whole message: the arming turn's text is what a burst would otherwise erase,
    // since the observer lane replaces a message's parts with whatever the snapshot holds.
    const lastParts = vi.mocked(io.streamChunk).mock.calls.at(-1)?.[2];
    expect(lastParts).toEqual([
      { type: 'text', text: 'arming turn said this' },
      { type: 'text', text: 'one two' },
    ]);
    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('extends the arming turn’s message rather than starting one per wake', async () => {
    const ch = channelQuery();
    const held = createSession('b2', () => ch.query);
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'b2',
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

    ch.emit(msg('text-delta', { delta: 'first wake' }));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    ch.emit(msg('text-delta', { delta: 'second wake' }));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));

    // A wait is one turn. Separate ids per wake made it render as N collapsed step bars with N
    // action rows, and left the renderer inferring the turn boundary from array position.
    const completions = vi.mocked(io.completeBurst).mock.calls;
    expect(completions).toHaveLength(2);
    expect(completions.map((c) => c[0])).toEqual([ARMING_MSG_ID, ARMING_MSG_ID]);
    // Both completions hand over the SAME array — the chunk history is shared by reference with
    // the turn context — so accumulation is asserted on the per-chunk snapshots, which are copies.
    expect(completions[0]?.[1].length).toBeGreaterThan(ARMING_CHUNK_COUNT);
    const finalSnapshot = vi.mocked(io.streamChunk).mock.calls.at(-1)?.[2];
    expect(finalSnapshot?.map((p) => p.text)).toEqual([
      'arming turn said this',
      'first wake',
      'second wake',
    ]);

    // Never restarts at 0: the renderer drops any chunk at or below its per-message high-water
    // mark, so a restart would silently freeze the transcript while the DB stayed correct.
    const indices = vi.mocked(io.streamChunk).mock.calls.map((c) => c[3]);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);
    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  /**
   * The regression this whole seam exists for. A task that finishes just before a burst's stop has
   * already left the Stop hook's snapshot while the notification reporting it is still queued, so
   * the wait reads as over one burst early. Standing down there discarded the burst that
   * notification started — in the field that was the model's compiled final answer, which reached
   * the CLI's own transcript and never the chat. Field cases: three sub-chats where agents.db's
   * last text is a "waiting on…" narration and the CLI transcript holds the real answer 5–11s later.
   */
  it('streams and persists a burst that arrives after the work read as finished', async () => {
    const ch = channelQuery();
    // Reports no pending work from the first stop onward — the stale snapshot, reproduced.
    const stopHook = { lastPendingWork: null, reset: vi.fn() } as unknown as TaskStopHook;
    const held = createSession('b-late', () => ch.query, { stopHook });
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'b-late',
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

    ch.emit(msg('text-delta', { delta: 'waiting on the last agent' }));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    expect(held.queue.closed).toBe(true); // the wait ended — and the reader carried on anyway

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('text-delta', { delta: 'all agents done — the full picture' }));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));

    const completions = vi.mocked(io.completeBurst).mock.calls;
    expect(completions).toHaveLength(2);
    // Same message id: a wait is one turn, whichever burst produced the text.
    expect(completions.map((c) => c[0])).toEqual([ARMING_MSG_ID, ARMING_MSG_ID]);
    expect(
      vi
        .mocked(io.streamChunk)
        .mock.calls.at(-1)?.[2]
        ?.map((p) => p.text),
    ).toEqual([
      'arming turn said this',
      'waiting on the last agent',
      'all agents done — the full picture',
    ]);

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('lets the burst persist before the pump reports the wait over', async () => {
    const ch = channelQuery();
    const stopHook = { lastPendingWork: null, reset: vi.fn() } as unknown as TaskStopHook;
    const held = createSession('b-persist-order', () => ch.query, { stopHook });
    const io = noopIo();
    const order: string[] = [];
    // A real finalize is a SQLite write, not synchronous. An unawaited one is abandoned when the
    // stand-down disposes the session, losing the burst's text with the pump that produced it.
    vi.mocked(io.completeBurst).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('persisted');
    });
    vi.mocked(io.setHeld).mockImplementation((h) => {
      if (!h) order.push('wait-over');
    });
    armWakePump({
      session: withArmingTurn(held),
      pendingWork,
      subChatId: 'b-persist-order',
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

    ch.emit(msg('text-delta', { delta: 'final answer' }));
    ch.emit(resultMsg());
    await vi.waitFor(() => expect(order).toContain('wait-over'));

    expect(order[0]).toBe('persisted');
  });
});

/**
 * A chat waiting between wake bursts is indistinguishable from a finished one everywhere else in
 * the renderer, so it renders the end-of-turn treatment over an agent that is still working. These
 * pin the retraction to EVERY way a hold can end — a stuck flag leaves the chat permanently
 * claiming to be busy, with nothing able to clear it short of a restart.
 */
describe('claude-wake-hold — held-state publication', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  const arm = (subChatId: string, io: WakeHoldIo, session: ReturnType<typeof createSession>) =>
    armWakePump({
      session: withArmingTurn(session),
      pendingWork,
      subChatId,
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });

  it('announces the wait as soon as the pump is armed', () => {
    const ch = channelQuery();
    const io = noopIo();
    arm(
      'h1',
      io,
      createSession('h1', () => ch.query),
    );

    expect(heldCalls(io)).toEqual([true]);
    ch.end();
  });

  it('retracts when the pump ends on its own (stream death / burst budget)', async () => {
    const ch = channelQuery();
    const io = noopIo();
    arm(
      'h2',
      io,
      createSession('h2', () => ch.query),
    );

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(heldCalls(io)).toEqual([true, false]);
    expect(hasWakeHold('h2')).toBe(false);
  });

  it('retracts when a follow-up turn adopts the hold', () => {
    const ch = channelQuery();
    const io = noopIo();
    arm(
      'h3',
      io,
      createSession('h3', () => ch.query),
    );

    // The adopting turn runs in the foreground — executing, not waiting.
    expect(takeWakeHold('h3')).toBeDefined();
    expect(heldCalls(io)).toEqual([true, false]);
    ch.end();
  });

  it('retracts immediately on user Stop, without waiting for the stream to unwind', () => {
    const ch = channelQuery();
    const io = noopIo();
    arm(
      'h4',
      io,
      createSession('h4', () => ch.query),
    );

    releaseWakeHold('h4', 'test-user-stop');

    // Synchronous: the affordance goes on the keystroke, not after the pump's async teardown.
    expect(heldCalls(io)).toEqual([true, false]);
    ch.end();
  });

  it('retracts on a stale release, where the map entry is dropped rather than the session ended', () => {
    const chA = channelQuery();
    const io = noopIo();
    arm(
      'h5',
      io,
      createSession('h5', () => chA.query),
    );

    // A successor session took the key while this hold's cleanup was still pending (ABA).
    endSession('h5');
    const chB = channelQuery();
    createSession('h5', () => chB.query);

    releaseWakeHold('h5', 'test-stale-release');

    expect(heldCalls(io)).toEqual([true, false]);
    chA.end();
    chB.end();
  });

  it("an orphaned pump's terminal never retracts a NEWER hold's wait", async () => {
    const chA = channelQuery();
    const orphanIo = noopIo();
    arm(
      'h6',
      orphanIo,
      createSession('h6', () => chA.query),
    );

    // Successor session + hold register under the same subChatId before the orphan unwinds.
    takeWakeHold('h6');
    endSession('h6');
    const chB = channelQuery();
    const successorIo = noopIo();
    arm(
      'h6',
      successorIo,
      createSession('h6', () => chB.query),
    );

    chA.end();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The successor is still advertising its wait — the orphan's identity guard held.
    expect(heldCalls(successorIo)).toEqual([true]);
    expect(hasWakeHold('h6')).toBe(true);
    chB.end();
  });
});

/**
 * The wait's detail is re-stated at every burst end, which is the only moment anything newer is
 * known. That republish sits BEFORE the pump consults its takeover and work-finished branches, so
 * every exit that lands mid-burst is followed by one more burst end — and a republish that ignored
 * this would re-advertise a wait the user already ended, which is the stuck row this row exists to
 * prevent. A takeover is unreachable by identity alone (it deletes the map entry, and its exit
 * never retracts); a Stop is too (it deliberately keeps the entry so the live pump stays adoptable).
 */
describe('claude-wake-hold — wait detail republish', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  const stopHookWith = (work: unknown): TaskStopHook =>
    ({ lastPendingWork: work, reset: () => {} }) as unknown as TaskStopHook;

  /** The pending-work detail published with each held-state value, in order. */
  const waitDetails = (io: WakeHoldIo) =>
    (
      io.setHeld as unknown as { mock: { calls: [boolean, { waitingOn: string[] }?][] } }
    ).mock.calls.map(([, pending]) => pending);

  const armDetailed = (subChatId: string, stopHook: TaskStopHook | null) => {
    const ch = channelQuery();
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(createSession(subChatId, () => ch.query, { stopHook })),
      pendingWork,
      subChatId,
      executionContextId: undefined,
      signalTaskId: null,
      io,
    });
    return { ch, io };
  };

  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('names the wait from the arming snapshot, mapping SDK task kinds to labels', () => {
    const { ch, io } = armDetailed('d1', null);

    expect(waitDetails(io)).toEqual([{ waitingOn: ['Command'] }]);
    ch.end();
  });

  it('arms on background subagents and names them as Agents', async () => {
    // A turn that launched background research agents and stopped to wait: the Stop hook's
    // snapshot lists them subagent-typed, and the wait must arm and name them.
    const hook = stopHookWith({
      backgroundTasks: [
        { id: 'a1', type: 'subagent', status: 'running', description: '' },
        { id: 'a2', type: 'subagent', status: 'running', description: '' },
      ],
      sessionCrons: [],
    });
    const { ch, io } = armDetailed('d-agents', hook);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await settle();

    expect(hasWakeHold('d-agents')).toBe(true);
    expect(waitDetails(io).at(-1)).toEqual({ waitingOn: ['Agent', 'Agent'] });
    ch.end();
  });

  it('re-states the detail from the burst’s OWN stop, not the arming snapshot', async () => {
    // The whole point: an arming snapshot only ever shrinks into a lie as tasks finish.
    const hook = stopHookWith({
      backgroundTasks: [
        { id: 'm1', type: 'monitor', status: 'running', description: '' },
        { id: 'm2', type: 'monitor', status: 'running', description: '' },
      ],
      sessionCrons: [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'x' }],
    });
    const { ch, io } = armDetailed('d2', hook);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await settle();

    expect(waitDetails(io)).toEqual([
      { waitingOn: ['Command'] },
      { waitingOn: ['Monitor', 'Monitor', 'Scheduled wake'] },
    ]);
    ch.end();
  });

  it('publishes an unknown task kind as a neutral label rather than the raw discriminant', async () => {
    const hook = stopHookWith({
      backgroundTasks: [{ id: 'x1', type: 'some_future_kind', status: 'running', description: '' }],
      sessionCrons: [],
    });
    const { ch, io } = armDetailed('d3', hook);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await settle();

    expect(waitDetails(io).at(-1)).toEqual({ waitingOn: ['Background task'] });
    ch.end();
  });

  it('does not re-advertise the wait after a follow-up turn adopts the hold mid-burst', async () => {
    const { ch, io } = armDetailed('d4', stopHookWith(pendingWork));

    ch.emit(msg('assistant')); // burst open
    expect(takeWakeHold('d4')).toBeDefined(); // adoption retracts
    ch.emit(resultMsg()); // the burst still ends
    await settle();

    // Without the latch this reads [true, false, true] and NOTHING retracts it: the pump exits
    // 'turn-taken-over', and the done handler finds no map entry to drop.
    expect(heldCalls(io)).toEqual([true, false]);
    ch.end();
  });

  it('does not re-advertise the wait after a user Stop lands mid-burst', async () => {
    const { ch, io } = armDetailed('d5', stopHookWith(pendingWork));

    ch.emit(msg('assistant'));
    releaseWakeHold('d5', 'test-user-stop'); // retracts eagerly, keeps the entry
    ch.emit(resultMsg()); // closing the queue does not truncate the in-flight burst
    await settle();

    // A re-appearing row after Stop reads as "Stop did not work" on the one surface proving it did.
    expect(heldCalls(io)).toEqual([true, false]);
    ch.end();
  });

  it('does not re-advertise on the final burst, so the wait ends without a flicker', async () => {
    const hook = stopHookWith(pendingWork);
    const { ch, io } = armDetailed('d6', hook);

    hook.lastPendingWork = null; // the harness reports nothing left in flight
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await settle();

    expect(heldCalls(io)).toEqual([true, false]);
    ch.end();
  });
});

/**
 * What ends a wait: the harness reporting nothing left in flight, and nothing else.
 *
 * A Monitor wakes the model once per matched output line, so wake COUNT bears no relation to how
 * long the watched work takes — any cap counted in wakes stands the session down while its work is
 * still running, and closing the session kills that work. These pin the wait to the work itself.
 */
describe('claude-wake-hold — stand-down policy', () => {
  beforeEach(() => {
    __resetSessionsForTest();
    vi.mocked(persistLinkedTaskSignal).mockClear();
  });

  /** A Stop hook whose reported pending work the test can change between bursts. */
  const stopHookWith = (work: unknown): TaskStopHook =>
    ({ lastPendingWork: work, reset: () => {} }) as unknown as TaskStopHook;

  const armWith = (
    subChatId: string,
    stopHook: TaskStopHook | null,
    signalTaskId: string | null,
  ) => {
    const ch = channelQuery();
    const io = noopIo();
    armWakePump({
      session: withArmingTurn(createSession(subChatId, () => ch.query, { stopHook })),
      pendingWork,
      subChatId,
      executionContextId: undefined,
      signalTaskId,
      io,
    });
    return { ch, io };
  };

  /** One wake burst: an assistant frame plus the terminal result the policy is evaluated on. */
  const wake = async (ch: ReturnType<typeof channelQuery>, result = resultMsg()) => {
    ch.emit(msg('assistant'));
    ch.emit(result);
    await new Promise((r) => setTimeout(r, 0));
  };

  it('keeps waiting across many wakes while the harness reports work in flight', async () => {
    const { ch } = armWith('sd1', stopHookWith(pendingWork), null);
    for (let i = 0; i < 12; i++) await wake(ch);
    expect(hasWakeHold('sd1')).toBe(true);
    ch.end();
  });

  it('never stands down on its own when there is no Stop hook to ask', async () => {
    // Liveness is the only rule, and without a hook the question is unanswerable — so the pump keeps
    // waiting rather than guessing the work is done. Only the stream ending releases it.
    const { ch } = armWith('sd11', null, null);
    for (let i = 0; i < 8; i++) await wake(ch);
    expect(hasWakeHold('sd11')).toBe(true);

    ch.end();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(hasWakeHold('sd11')).toBe(false);
  });

  it('stands down on the first burst that ends with nothing left in flight', async () => {
    const hook = stopHookWith(pendingWork);
    const { ch, io } = armWith('sd2', hook, null);
    await wake(ch);
    expect(hasWakeHold('sd2')).toBe(true);

    // The backgrounded command finished, so the CLI's next Stop reports an empty snapshot.
    hook.lastPendingWork = null;
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));
    expect(heldCalls(io).at(-1)).toBe(false);
  });

  it('leaves the session alone when a follow-up turn adopted the hold', async () => {
    const { ch, io } = armWith('sd10', stopHookWith(pendingWork), null);
    const hold = takeWakeHold('sd10');
    expect(hold).toBeDefined();

    // A user's follow-up adopts the live pump rather than spawning a second process over it.
    const taken = hold?.pump.startTurn({ type: 'user' } as never, () => {});
    await new Promise((r) => setTimeout(r, 0));
    ch.emit(resultMsg());
    await taken;
    await new Promise((r) => setTimeout(r, 0));

    // The adopting execute owns the session now, so the pump's own cleanup must keep its hands off:
    // disposing here would close the queue out from under the turn the user is watching.
    expect(getSession('sd10')).toBeDefined();
    expect(io.clearPendingApprovals).not.toHaveBeenCalled();
    ch.end();
  });

  it('reconciles the adopted mode at the takeover push, never under a streaming burst', async () => {
    const { ch } = armWith('sd12', stopHookWith(pendingWork), null);
    ch.emit(msg('assistant')); // a burst opens and stays mid-stream — no result yet
    await new Promise((r) => setTimeout(r, 0));
    const hold = takeWakeHold('sd12');
    expect(hold).toBeDefined();
    const session = hold?.session as ClaudeSession;
    const events: string[] = [];
    const setPermissionMode = vi.fn(async (mode: 'auto' | 'default' | 'plan') => {
      events.push(`mode:${mode}`);
    });
    Object.assign(session.query, { setPermissionMode });
    const originalPush = session.queue.push.bind(session.queue);
    session.queue.push = (m) => {
      events.push('push');
      originalPush(m);
    };
    const adoptingTurn = createClaudeTurnContext();

    // A plan follow-up adopts mid-burst: the SDK mode must not change under the streaming burst
    // (the arming mode is the one it runs under) — the reconcile belongs to the push boundary.
    const taken = hold?.pump.startTurn(
      { type: 'user' } as never,
      () => {},
      adoptedTurnBeforePush({
        session,
        turn: adoptingTurn,
        signal: new AbortController().signal,
        mode: 'plan',
        nativeAutoReview: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(setPermissionMode).not.toHaveBeenCalled();

    ch.emit(resultMsg()); // the in-flight burst completes — the takeover boundary
    await new Promise((r) => setTimeout(r, 0));
    // Reconciled to the mode a fresh plan session opens in, before the user message was pushed.
    expect(events).toEqual(['mode:plan', 'push']);
    expect(session.currentTurn).toBe(adoptingTurn);

    ch.emit(resultMsg()); // the adopted turn's own boundary
    await taken;
    ch.end();
  });

  it('a takeover the reconcile refuses is disposed after the burst, with no surfaced error', async () => {
    const { ch } = armWith('sd13', stopHookWith(pendingWork), null);
    ch.emit(msg('assistant'));
    await new Promise((r) => setTimeout(r, 0));
    const hold = takeWakeHold('sd13');
    expect(hold).toBeDefined();
    const session = hold?.session as ClaudeSession;
    Object.assign(session.query, {
      setPermissionMode: vi.fn(async () => {
        throw new Error('Cannot set permission mode: gate is not enabled');
      }),
    });

    const taken = hold?.pump.startTurn(
      { type: 'user' } as never,
      () => {},
      adoptedTurnBeforePush({
        session,
        turn: createClaudeTurnContext(),
        signal: new AbortController().signal,
        mode: 'plan',
        nativeAutoReview: false,
      }),
    );
    ch.emit(resultMsg()); // the burst completes UNKILLED; only then does the reconcile fail
    const rejection = await taken?.catch((err) => err);
    expect(isPumpAdoptRefusedError(rejection)).toBe(true);

    // 'interrupted' is not a turn-owned exit, so pump cleanup disposes the session and the
    // executor's adopt-refused rerun opens fresh — in the right mode natively. Dispose+fresh.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(getSession('sd13')).toBeUndefined();
    expect(captureMainException).not.toHaveBeenCalled();
  });

  it('finalizes a burst the stream death cut short', async () => {
    const { ch, io } = armWith('sd9', stopHookWith(pendingWork), null);
    ch.emit(msg('text-start', { id: 'partial' }));
    ch.emit(msg('text-delta', { id: 'partial', delta: 'got this far' }));
    await new Promise((r) => setTimeout(r, 0));

    ch.end(); // stream death mid-burst: no result, and no budget tripped
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The partial still persists — dropping it would lose everything the burst streamed, and
    // skipping completeBurst would strand the local-execution mark and mute this chat's relay.
    const last = vi.mocked(io.completeBurst).mock.calls.at(-1);
    expect(last?.[2]).toBe(true);
    expect(JSON.stringify(last?.[1])).toContain('got this far');
    // Nothing tripped, so the transcript gets no closing line.
    expect(JSON.stringify(last?.[1])).not.toContain('Stopped watching background work');
  });

  it('finalizes a LATE burst the stream death cut short', async () => {
    // The post-EOF drain carries a burst the old stand-down used to skip, putting that burst on the
    // cut-short path for the first time. It is the one carrying the answer, so a partial that fails
    // to persist here reinstates the original bug by another route.
    const { ch, io } = armWith('sd-late-cut-short', stopHookWith(null), null);

    ch.emit(msg('assistant'));
    ch.emit(resultMsg()); // reads as finished — the wait's advertisement ends, the reading does not
    await new Promise((r) => setTimeout(r, 0));

    ch.emit(msg('system', { subtype: 'task_notification' }));
    ch.emit(msg('text-start', { id: 'late' }));
    ch.emit(msg('text-delta', { id: 'late', delta: 'the compiled answer' }));
    await new Promise((r) => setTimeout(r, 0));
    ch.end(); // dies before its own result
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const last = vi.mocked(io.completeBurst).mock.calls.at(-1);
    expect(last?.[0]).toBe(ARMING_MSG_ID);
    expect(JSON.stringify(last?.[1])).toContain('the compiled answer');
  });

  it('still finalizes a cut-short burst when denied-tool backfill streaming throws', async () => {
    const ch = channelQuery();
    const session = createSession('sd-backfill-error', () => ch.query, {
      stopHook: stopHookWith(pendingWork),
    });
    const io = noopIo();
    const backfillError = new Error('synthetic backfill send failed');
    vi.mocked(io.streamChunk).mockImplementation((_msgId, chunk) => {
      if (chunk.type === 'tool-output-error') throw backfillError;
    });
    const releaseFlowResourceActivity = vi.fn();
    armWakePump({
      session: withArmingTurn(session),
      pendingWork,
      subChatId: 'sd-backfill-error',
      executionContextId: undefined,
      signalTaskId: null,
      releaseFlowResourceActivity,
      io,
    });

    ch.emit(msg('tool-input-available', { toolCallId: 'denied-cut-short', toolName: 'Bash' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    session.currentTurn?.deniedToolIdsWithMessages.set('denied-cut-short', 'Denied by policy.');
    ch.end();

    await vi.waitFor(() => expect(releaseFlowResourceActivity).toHaveBeenCalledWith(backfillError));
    expect(io.completeBurst).toHaveBeenCalledOnce();
  });
});

/**
 * The agent's own `done` outranks a task the harness still lists. Observed failure: a backgrounded
 * `tail -f` cannot exit on its own, so the CLI reports it forever and the chat advertised a wait
 * over a run frink's own task row had already marked done.
 */
describe('claude-wake-hold — a turn that declared its work done', () => {
  const TURN_START = '2026-08-01T00:00:00.000Z';
  const sig = (state: string, at: string | undefined = '2026-08-01T00:00:10.000Z') =>
    ({ state, summary: '', at }) as unknown as TaskSignalPayload;
  /** Pending work of the given task kinds (plus optional crons), as the Stop hook reports it. */
  const work = (types: string[], crons = 0) =>
    ({
      backgroundTasks: types.map((type, i) => ({ id: `t${i}`, type, status: 'running' })),
      sessionCrons: Array.from({ length: crons }, (_, i) => ({ id: `c${i}` })),
    }) as never;

  it.each(['done', 'completed'])(
    '`%s` ends the wait even though the harness still lists work',
    (state) => {
      expect(declaresWaitOver(sig(state), null, TURN_START)).toBe(true);
    },
  );

  // Each exclusion is load-bearing, not conservatism. `awaiting_input` is the sharpest: its exit is
  // a follow-up message that ADOPTS the live session, so ending its wait destroys the very work the
  // answer exists to resume.
  it.each(['awaiting_input', 'partial', 'blocked', 'failed'])(
    '`%s` leaves the wait standing',
    (state) => {
      expect(declaresWaitOver(sig(state), null, TURN_START)).toBe(false);
    },
  );

  // These are written FOR the agent (the park sweep, a manual confirmation), never by it, so they
  // must never speak for it. A set derived from TASK_SIGNAL_STATES would include them.
  it.each(['manual_confirmation', 'missing_completion_signal'])(
    '`%s` is not the agent speaking, so it does not end the wait',
    (state) => {
      expect(declaresWaitOver(sig(state), null, TURN_START)).toBe(false);
    },
  );

  it('keeps waiting while a ScheduleWakeup cron is pending', () => {
    // A cron is work the USER set up; the agent's `done` does not speak for it, and standing down
    // would drop it with the session.
    expect(declaresWaitOver(sig('done'), work([], 1), TURN_START)).toBe(false);
  });

  // Harness-settled kinds always report back, so a `done` over one is the agent mispredicting —
  // dropping it kills real work (two background subagents; `done` after the first killed the
  // second). Mirrors the CLI's own hold-back, which never releases over live agent/workflow tasks.
  it.each(['subagent', 'workflow'])('a live `%s` task vetoes the declaration', (type) => {
    expect(declaresWaitOver(sig('done'), work([type]), TURN_START)).toBe(false);
    expect(declaresWaitOver(sig('done'), work(['shell', type]), TURN_START)).toBe(false);
  });

  // The un-exitable kinds keep the override — a backgrounded `tail -f` or a stale monitor never
  // leaves the list, which is the failure the declared-done rule exists for.
  it.each(['shell', 'monitor'])('a live `%s` task alone does not veto the declaration', (type) => {
    expect(declaresWaitOver(sig('done'), work([type]), TURN_START)).toBe(true);
  });

  it('ignores a `done` older than the turn', () => {
    // The signal slot is per EXECUTION CONTEXT and never cleared, and an adopting turn reuses the
    // arming turn's context — so without the anchor an earlier turn's verdict would end this one.
    expect(declaresWaitOver(sig('done', '2025-01-01T00:00:00.000Z'), null, TURN_START)).toBe(false);
  });

  it('ignores a signal with no timestamp to compare', () => {
    const undated = { state: 'done', summary: '' } as unknown as TaskSignalPayload;
    expect(declaresWaitOver(undated, null, TURN_START)).toBe(false);
  });

  it('honours a `done` when there is no anchor to compare against', () => {
    expect(declaresWaitOver(sig('done'), null, null)).toBe(true);
  });

  it('says nothing about a turn that never signalled', () => {
    expect(declaresWaitOver(null, null, TURN_START)).toBe(false);
  });
});

describe('claude-wake-hold — standing down on a declared done', () => {
  beforeEach(() => {
    __resetSessionsForTest();
    vi.mocked(persistLinkedTaskSignal).mockClear();
  });

  const stopHookWith = (work: unknown): TaskStopHook =>
    ({ lastPendingWork: work, reset: () => {} }) as unknown as TaskStopHook;

  /** Arms a hold whose signal slot the test drives — empty at arming, so the anchor the pump takes
   * there is the arming turn's start and a signal declared mid-wait reads as newer. */
  const armSignalled = (
    subChatId: string,
    stopHook: TaskStopHook,
    signalTaskId: string | null = null,
  ) => {
    const ch = channelQuery();
    let signal: TaskSignalPayload | null = null;
    const io: WakeHoldIo = { ...noopIo(), getLatestTaskSignal: vi.fn(() => signal) };
    armWakePump({
      session: withArmingTurn(createSession(subChatId, () => ch.query, { stopHook })),
      pendingWork,
      subChatId,
      executionContextId: 'ctx-sig',
      signalTaskId,
      io,
    });
    return {
      ch,
      io,
      declare: (state: string) => {
        // Postdates the arming turn's `startedAt` anchor, as a real mid-wait signal would.
        signal = {
          state,
          summary: '',
          at: new Date(Date.now() + 60_000).toISOString(),
        } as TaskSignalPayload;
      },
    };
  };

  const wake = async (ch: ReturnType<typeof channelQuery>) => {
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
  };

  it('stands down on the burst that declared it, with work still listed', async () => {
    const { ch, io, declare } = armSignalled('sig1', stopHookWith(pendingWork));
    await wake(ch);
    expect(hasWakeHold('sig1')).toBe(true);

    // The harness still reports the task — a `tail -f` never will not — but the agent has spoken.
    declare('done');
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));
    expect(heldCalls(io).at(-1)).toBe(false);
  });

  it('does not re-advertise the wait on that burst', async () => {
    // Order, not final value: the registry runs onBurstEnd BEFORE the work-finished branch, so an
    // unguarded republish flickers one last `held: true` at a user the wait is ending for.
    const { ch, io, declare } = armSignalled('sig2', stopHookWith(pendingWork));
    declare('done');
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));

    expect(heldCalls(io)).toEqual([true, false]);
  });

  it('keeps waiting when the burst declares a state that parks rather than ends', async () => {
    const { ch, declare } = armSignalled('sig3', stopHookWith(pendingWork));
    declare('awaiting_input');
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));

    // The user's answer adopts this live session; ending the wait would strand its background work.
    expect(hasWakeHold('sig3')).toBe(true);
    ch.end();
  });

  it('keeps waiting when nothing was declared, however many times the harness wakes', async () => {
    // The regression guard for a legitimately long wait — a benchmark monitor that narrates for
    // hours must not be ended by this seam.
    const { ch } = armSignalled('sig4', stopHookWith(pendingWork));
    for (let i = 0; i < 6; i++) await wake(ch);
    expect(hasWakeHold('sig4')).toBe(true);
    ch.end();
  });

  const subagentWork = {
    backgroundTasks: [
      { id: 'a1', type: 'subagent', status: 'running' },
      { id: 'a2', type: 'subagent', status: 'running' },
    ],
    sessionCrons: [],
  } as never;

  it('defers a `done` declared over live subagents — the hold and the wait survive', async () => {
    // Two background subagents; the agent signals done after the first reports. Honoring it here
    // would close the session and kill the second agent mid-work — and eagerly persisting it
    // would let the renderer terminalize the task while the pump still holds. Deferred on both.
    const hook = stopHookWith(subagentWork);
    const { ch, io, declare } = armSignalled('sig5', hook, 'task-sig5');
    declare('done');
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));

    expect(hasWakeHold('sig5')).toBe(true);
    expect(persistLinkedTaskSignal).not.toHaveBeenCalled();
    // The wait is re-advertised, not retracted — the chat is still working.
    expect(heldCalls(io).at(-1)).toBe(true);
    ch.end();
  });

  it('honors the standing declaration once the vetoing subagents settle, then writes no more', async () => {
    // The veto is "not yet", not "never": the cursor does not advance past a deferred done, so the
    // agent need not repeat it — the first burst whose snapshot has no subagents stands down and
    // persists it then.
    const hook = stopHookWith(subagentWork);
    const { ch, io, declare } = armSignalled('sig6', hook, 'task-sig6');
    declare('done');
    await wake(ch);
    expect(hasWakeHold('sig6')).toBe(true);

    hook.lastPendingWork = pendingWork; // subagents settled; only the shell task remains
    await wake(ch);
    await new Promise((r) => setTimeout(r, 0));
    expect(heldCalls(io).at(-1)).toBe(false);
    expect(persistLinkedTaskSignal).toHaveBeenCalledWith(
      expect.objectContaining({ taskIdForExecution: 'task-sig6' }),
    );

    vi.mocked(persistLinkedTaskSignal).mockClear();
    await wake(ch); // a burst the CLI still owed after EOF: text only, never a second verdict
    expect(persistLinkedTaskSignal).not.toHaveBeenCalled();
  });
});

describe('claude-wake-hold — app-quit sweep', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  it('stands a plain chat hold down through its session queue', () => {
    const { io } = armChatHold('quit-chat');

    releaseNonFlowClaudeSessions('app-quit');

    expect(getSession('quit-chat')).toBeUndefined();
    expect(heldCalls(io).at(-1)).toBe(false);
  });

  it('leaves a Flow hold armed so its admission ticket is untouched', () => {
    const { io, releaseFlowResourceActivity, releaseRuntimeSlot, unregisterFlowRunAbort } =
      armFlowHold('quit-flow');

    releaseNonFlowClaudeSessions('app-quit');

    expect(releaseFlowResourceActivity).not.toHaveBeenCalled();
    expect(releaseRuntimeSlot).not.toHaveBeenCalled();
    expect(unregisterFlowRunAbort).not.toHaveBeenCalled();
    expect(hasWakeHold('quit-flow')).toBe(true);
    expect(heldCalls(io)).toEqual([true]);

    // Quit-scoped, not a permanent exemption — Stop still reaches this hold.
    releaseWakeHold('quit-flow', 'stop');
    expect(getSession('quit-flow')).toBeUndefined();
  });

  it('releases only the plain hold when both kinds are armed', () => {
    const chat = armChatHold('mixed-chat');
    const flow = armFlowHold('mixed-flow');

    releaseNonFlowClaudeSessions('app-quit');

    expect(getSession('mixed-chat')).toBeUndefined();
    expect(getSession('mixed-flow')).toBe(flow.session);
    expect(heldCalls(chat.io).at(-1)).toBe(false);
    expect(flow.releaseFlowResourceActivity).not.toHaveBeenCalled();
  });

  it('retires idle sessions in the same sweep, still sparing a Flow hold', () => {
    const close = vi.fn();
    retainSession(createSession('quit-idle', () => Object.assign(channelQuery().query, { close })));
    const flow = armFlowHold('quit-idle-flow');

    releaseNonFlowClaudeSessions('app-quit');

    expect(close).toHaveBeenCalledOnce();
    expect(getSession('quit-idle')).toBeUndefined();
    expect(getSession('quit-idle-flow')).toBe(flow.session);
  });
});

describe('claude-wake-hold — enumerating live holds for a booting renderer', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  const stopHookWith = (work: unknown): TaskStopHook =>
    ({ lastPendingWork: work, reset: () => {} }) as unknown as TaskStopHook;

  const armListed = (subChatId: string, stopHook: TaskStopHook | null) => {
    const ch = channelQuery();
    armWakePump({
      session: withArmingTurn(createSession(subChatId, () => ch.query, { stopHook })),
      pendingWork,
      subChatId,
      executionContextId: undefined,
      signalTaskId: null,
      io: noopIo(),
    });
    return ch;
  };

  it('names every live hold, so a reloaded window can re-seed all of them at once', () => {
    const chA = armListed('boot-a', stopHookWith(pendingWork));
    const chB = armListed(
      'boot-b',
      stopHookWith({
        backgroundTasks: [{ id: 'm1', type: 'monitor', status: 'running' }],
        sessionCrons: [{ id: 'c1' }],
      }),
    );

    expect(listWakeHolds()).toEqual([
      { subChatId: 'boot-a', pending: { waitingOn: ['Command'] } },
      { subChatId: 'boot-b', pending: { waitingOn: ['Monitor', 'Scheduled wake'] } },
    ]);
    chA.end();
    chB.end();
  });

  // The trap this filter exists for: a stopped hold KEEPS its map entry so its still-live pump
  // stays adoptable, so membership does not mean "waiting" — only `retracted` answers that.
  it('omits a stopped hold whose registry entry deliberately survives the stop', () => {
    const ch = armListed('boot-stopped', stopHookWith(pendingWork));
    const session = getSession('boot-stopped');
    if (!session) throw new Error('Expected the held session');
    releaseWakeHold('boot-stopped', 'user stop');

    expect(hasWakeHold('boot-stopped')).toBe(true);
    expect(hasWakeHold('boot-stopped', session)).toBe(false);
    expect(listWakeHolds()).toEqual([]);
    ch.end();
  });

  it('names what the wait is blocked on NOW, not the snapshot it armed with', async () => {
    // The pull and push lanes must read one source. A snapshot cached at arming time only ever
    // shrinks into a lie as tasks finish — and a window that just reloaded is exactly who would be
    // shown it, with no burst of its own to correct the record.
    const hook = stopHookWith({
      backgroundTasks: [
        { id: 'm1', type: 'monitor', status: 'running' },
        { id: 'm2', type: 'monitor', status: 'running' },
      ],
      sessionCrons: [],
    });
    const ch = armListed('boot-latest', hook);
    expect(listWakeHolds()).toEqual([
      { subChatId: 'boot-latest', pending: { waitingOn: ['Monitor', 'Monitor'] } },
    ]);

    // One monitor settles; the burst's own stop rewrites the snapshot.
    hook.lastPendingWork = {
      backgroundTasks: [{ id: 'm2', type: 'monitor', status: 'running' }],
      sessionCrons: [{ id: 'c1' }],
    } as never;
    ch.emit(msg('assistant'));
    ch.emit(resultMsg());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(listWakeHolds()).toEqual([
      { subChatId: 'boot-latest', pending: { waitingOn: ['Monitor', 'Scheduled wake'] } },
    ]);
    ch.end();
  });

  it('lists only the live hold when a stopped one shares the registry', () => {
    // Separate cases cannot catch a filter that is all-or-nothing; a mixed registry can.
    const live = armListed('boot-live', stopHookWith(pendingWork));
    const dead = armListed('boot-dead', stopHookWith(pendingWork));
    releaseWakeHold('boot-dead', 'user stop');

    expect(listWakeHolds()).toEqual([
      { subChatId: 'boot-live', pending: { waitingOn: ['Command'] } },
    ]);
    live.end();
    dead.end();
  });

  it('omits a hold whose stop hook reports nothing left in flight', () => {
    // The wait is over as far as the harness is concerned; the pump stands down at its next burst
    // end. Publishing it would name a wait with nothing to show, which the renderer rejects anyway.
    const ch = armListed('boot-empty', stopHookWith(null));

    expect(hasWakeHold('boot-empty')).toBe(true);
    expect(listWakeHolds()).toEqual([]);
    ch.end();
  });
});

describe('claude-wake-hold — task kinds that collide with Object.prototype', () => {
  beforeEach(() => {
    __resetSessionsForTest();
  });

  // `type` is an unbounded string off the SDK. Looked up on an object literal, these three resolve
  // to INHERITED members — a function or the prototype — which the `??` fallback cannot catch. The
  // renderer requires every label to be a string and drops the whole frame otherwise, so a single
  // such task would silently cost the chat its held row and the only Stop it has between bursts.
  it.each(['constructor', 'toString', '__proto__'])(
    'labels a %s-typed task neutrally rather than leaking a prototype member',
    (type) => {
      const ch = channelQuery();
      const work = {
        backgroundTasks: [{ id: 'p1', type, status: 'running', description: '' }],
        sessionCrons: [],
      };
      const stopHook = Object.assign(async () => ({}), { reset: () => {}, lastPendingWork: work });
      armWakePump({
        session: withArmingTurn(createSession(`proto-${type}`, () => ch.query, { stopHook })),
        pendingWork: work,
        subChatId: `proto-${type}`,
        executionContextId: undefined,
        signalTaskId: null,
        io: noopIo(),
      });

      expect(listWakeHolds()).toEqual([
        { subChatId: `proto-${type}`, pending: { waitingOn: ['Background task'] } },
      ]);
      ch.end();
    },
  );
});
