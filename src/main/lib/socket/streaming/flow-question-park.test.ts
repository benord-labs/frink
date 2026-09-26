import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { ClaudeSession } from '../claude-session-registry';
import { parkHeldQuestion } from './question-hold-park';

const mocks = vi.hoisted(() => ({
  persistLinkedTaskSignal: vi.fn(),
  unregisterSessionIfOwned: vi.fn(),
  captureMainMessage: vi.fn(),
}));

vi.mock('../../trpc/routers/frink-task-signal-persist', () => ({
  persistLinkedTaskSignal: mocks.persistLinkedTaskSignal,
}));
vi.mock('../claude-session-registry', () => ({
  unregisterSessionIfOwned: mocks.unregisterSessionIfOwned,
}));
vi.mock('../../sentry/init', () => ({
  captureMainMessage: mocks.captureMainMessage,
}));

const signal: TaskSignalPayload = {
  state: 'awaiting_input',
  summary: 'Needs your input',
  at: '2026-08-02T12:00:00.000Z',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claudeSession(): ClaudeSession {
  const queue = {
    closed: false,
    close: vi.fn(() => {
      queue.closed = true;
    }),
  };
  return {
    subChatId: 'sub-1',
    query: { interrupt: vi.fn(async () => {}), return: vi.fn(async () => {}) },
    queue,
    lastActiveAt: 0,
    busy: true,
    interruptExpected: false,
    turnSettled: null,
    currentTurn: null,
  } as unknown as ClaudeSession;
}

describe('parkHeldQuestion — race-safe Flow settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistLinkedTaskSignal.mockResolvedValue(true);
  });

  it('persists before retiring the card and waits for exact executor settlement', async () => {
    const order: string[] = [];
    const settlement = deferred();
    const abortController = new AbortController();
    abortController.signal.addEventListener('abort', () => order.push('abort'));
    mocks.persistLinkedTaskSignal.mockImplementation(async () => {
      order.push('persist');
      return true;
    });
    const parking = parkHeldQuestion({
      signal,
      subChatId: 'sub-1',
      signalTaskId: 'task-1',
      isFlowTurn: true,
      abortController,
      abortSources: new Map(),
      onPersisted: () => order.push('retire-card'),
      waitForSettlement: () => {
        order.push('wait');
        return settlement.promise;
      },
      questionSession: claudeSession(),
    });

    await vi.waitFor(() => expect(order).toEqual(['persist', 'retire-card', 'abort', 'wait']));
    let finished = false;
    void parking.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    settlement.resolve();
    await expect(parking).resolves.toBeUndefined();
  });

  it('keeps the provider live when no durable park was written', async () => {
    mocks.persistLinkedTaskSignal.mockResolvedValue(false);
    const abortController = new AbortController();
    const onPersisted = vi.fn();
    const waitForSettlement = vi.fn();

    await expect(
      parkHeldQuestion({
        signal,
        subChatId: 'sub-1',
        signalTaskId: 'task-1',
        isFlowTurn: true,
        abortController,
        abortSources: new Map(),
        onPersisted,
        waitForSettlement,
        questionSession: claudeSession(),
      }),
    ).rejects.toThrow('did not update its linked task');
    expect(onPersisted).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
    expect(waitForSettlement).not.toHaveBeenCalled();
  });

  it('propagates cleanup failure after the durable park and kill', async () => {
    const abortController = new AbortController();
    const cleanupError = new Error('cleanup failed');

    await expect(
      parkHeldQuestion({
        signal,
        subChatId: 'sub-1',
        signalTaskId: 'task-1',
        isFlowTurn: true,
        abortController,
        abortSources: new Map(),
        onPersisted: vi.fn(),
        waitForSettlement: async () => {
          throw cleanupError;
        },
        questionSession: claudeSession(),
      }),
    ).rejects.toBe(cleanupError);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('aborts and closes only the captured session when its kill rejects', async () => {
    const session = claudeSession();
    vi.mocked(session.query.return).mockRejectedValueOnce(new Error('transport already closed'));
    const abortController = new AbortController();

    await expect(
      parkHeldQuestion({
        signal,
        subChatId: 'sub-1',
        signalTaskId: 'task-1',
        isFlowTurn: true,
        abortController,
        abortSources: new Map(),
        onPersisted: vi.fn(),
        waitForSettlement: async () => {},
        questionSession: session,
      }),
    ).resolves.toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(mocks.unregisterSessionIfOwned).toHaveBeenCalledWith(session);
    expect(session.queue.close).toHaveBeenCalledOnce();
  });
});
