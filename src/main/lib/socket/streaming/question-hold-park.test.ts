import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingToolApprovals } from '../../claude/ask-user-question-approval';
import { PERMISSION_PROMPT_TIMEOUT_MS } from '../../permissions/constants';
import { latchAbortReason } from '../../tasks/stream-error-disposition';
import type { ClaudeSession } from '../claude-session-registry';
import { holdOrParkQuestion } from './question-hold-park';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../sentry/init', () => ({ captureMainMessage: vi.fn() }));

const { persistLinkedTaskSignalMock, unregisterSessionIfOwnedMock } = vi.hoisted(() => ({
  persistLinkedTaskSignalMock: vi.fn(),
  unregisterSessionIfOwnedMock: vi.fn(),
}));
vi.mock('../../trpc/routers/frink-task-signal-persist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../trpc/routers/frink-task-signal-persist')>()),
  persistLinkedTaskSignal: persistLinkedTaskSignalMock,
}));
vi.mock('../claude-session-registry', () => ({
  unregisterSessionIfOwned: unregisterSessionIfOwnedMock,
}));

const question = {
  question: 'How should this land?',
  header: 'Direction',
  multiSelect: false,
  options: [{ label: 'Split it', description: 'Pay the debt' }],
};

/**
 * A live session whose kill is observable. The `return` fake mirrors the real SDK split: the input
 * stream ends (and with it the turn) INSIDE the call, while the returned promise settles on a later
 * tick — so `onKill` snapshots what the executor's post-turn teardown could already observe.
 */
const liveSession = (onKill?: () => void) => {
  const queue = {
    closed: false,
    close: vi.fn(() => {
      queue.closed = true;
    }),
  };
  const session = {
    subChatId: 'sub-1',
    interruptExpected: false,
    query: {
      interrupt: vi.fn(async () => {}),
      return: vi.fn(async () => {
        onKill?.();
        await Promise.resolve();
      }),
    },
    queue,
  };
  return session;
};
// SAFETY: the park reads only subChatId, interruptExpected, queue and query off the session.
const asSession = (session: ReturnType<typeof liveSession>) => session as unknown as ClaudeSession;

/** Run a hold to expiry and report what the park did. */
async function parkAfterExpiry(opts: {
  isFlowTurn: boolean;
  session: ReturnType<typeof liveSession>;
  abortController?: AbortController;
  abortSources?: Map<string, string>;
}) {
  const abortController = opts.abortController ?? new AbortController();
  const abortSources = opts.abortSources ?? new Map<string, string>();
  vi.useFakeTimers();

  void holdOrParkQuestion({
    toolUseID: 'tu-park',
    toolInput: { questions: [question] },
    chatId: 'chat-1',
    subChatId: 'sub-1',
    signalTaskId: null,
    isFlowTurn: opts.isFlowTurn,
    emitChunk: () => {},
    abortController,
    abortSources,
    waitForSettlement: async () => {},
    questionSession: asSession(opts.session),
  });
  await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(0);

  return { aborted: abortController.signal.aborted, abortSources };
}

describe('holdOrParkQuestion — how the turn ends', () => {
  beforeEach(() => {
    vi.useRealTimers();
    pendingToolApprovals.clear();
    persistLinkedTaskSignalMock.mockReset().mockResolvedValue(true);
    unregisterSessionIfOwnedMock.mockReset();
  });

  // The kill ends this turn on its own: the CLI is never interrupted (an interrupt is a control
  // request it answers by refusing the pending question for us), and no abort means no stream-error
  // disposition for a turn that ended deliberately.
  it('ends an attended chat’s turn by killing the session — no interrupt, no abort', async () => {
    const atKill: Record<string, boolean> = {};
    const session = liveSession(() => {
      atKill.unregistered = unregisterSessionIfOwnedMock.mock.calls.some(([s]) => s === session);
      atKill.queueClosed = session.queue.closed;
    });

    const { aborted, abortSources } = await parkAfterExpiry({ isFlowTurn: false, session });

    expect(session.query.return).toHaveBeenCalled();
    expect(session.query.interrupt).not.toHaveBeenCalled();
    expect(session.interruptExpected).toBe(true);
    // The turn ends inside `query.return()`: the queue must already be closed (so the post-turn
    // disposition disposes instead of arming a wake pump on the dead query), while the registry
    // entry must survive until teardown resolves (so a concurrent duplicate execute still finds
    // the session and honors the turnSettled wait instead of spawning a second CLI against it).
    expect(atKill).toEqual({ unregistered: false, queueClosed: true });
    expect(unregisterSessionIfOwnedMock).toHaveBeenCalledWith(session);
    expect(aborted).toBe(false);
    expect(abortSources.size).toBe(0);
  });

  // A flow turn has nobody waiting, and its adopted-session case runs under a different execute's
  // controller — so it also aborts, stamped BEFORE the kill: the stream can end inside the kill, and
  // a throw from the executor tail must already classify as deliberate.
  it('stamps the flow abort reason before the kill, then aborts the controller', async () => {
    const abortSources = new Map<string, string>();
    let stampAtKill: string | undefined;
    let abortedAtKill: boolean | undefined;
    const atKill: Record<string, boolean> = {};
    const abortController = new AbortController();
    const session = liveSession(() => {
      stampAtKill = abortSources.get('sub-1');
      abortedAtKill = abortController.signal.aborted;
      atKill.unregistered = unregisterSessionIfOwnedMock.mock.calls.some(([s]) => s === session);
      atKill.queueClosed = session.queue.closed;
    });
    const readReason = latchAbortReason(abortController.signal, abortSources, 'sub-1');

    const { aborted } = await parkAfterExpiry({
      isFlowTurn: true,
      session,
      abortController,
      abortSources,
    });

    expect(session.query.return).toHaveBeenCalled();
    expect(session.query.interrupt).not.toHaveBeenCalled();
    expect(stampAtKill).toBe('question-park');
    expect(abortedAtKill).toBe(false);
    expect(atKill).toEqual({ unregistered: false, queueClosed: true });
    expect(unregisterSessionIfOwnedMock).toHaveBeenCalledWith(session);
    expect(aborted).toBe(true);
    // What the executor's catch would see on a late throw: a deliberate stop, not an api-error.
    expect(readReason()).toBe('question-park');
  });

  it('parks with the tool’s own questions before ending the turn', async () => {
    await parkAfterExpiry({ isFlowTurn: false, session: liveSession() });

    expect(persistLinkedTaskSignalMock).toHaveBeenCalledWith({
      taskIdForExecution: null,
      signal: expect.objectContaining({ state: 'awaiting_input', questions: [question] }),
    });
  });

  // The regression this module exists to prevent: an expiry must never put a message in front of
  // the model. The hold promise stays unsettled, the pending entry is gone before any late answer
  // could deliver a decision, and the CLI is never asked to end the turn itself.
  it.each([{ isFlowTurn: false }, { isFlowTurn: true }])(
    'delivers no response on expiry — hold unsettled, approval gone, no interrupt (isFlowTurn: $isFlowTurn)',
    async ({ isFlowTurn }) => {
      const session = liveSession();
      vi.useFakeTimers();
      let settled = false;
      const hold = holdOrParkQuestion({
        toolUseID: 'tu-park',
        toolInput: { questions: [question] },
        chatId: 'chat-1',
        subChatId: 'sub-1',
        signalTaskId: null,
        isFlowTurn,
        emitChunk: () => {},
        abortController: new AbortController(),
        abortSources: new Map(),
        waitForSettlement: async () => {},
        questionSession: asSession(session),
      });
      hold.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(pendingToolApprovals.has('tu-park')).toBe(false);
      expect(session.query.interrupt).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    },
  );
});
