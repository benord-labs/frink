import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sentry/init', () => ({
  captureMainException: vi.fn(),
  captureMainMessage: vi.fn(),
}));

import { captureMainMessage } from '../../sentry/init';
import type { StopPendingWork, TaskStopHook } from '../../task-stop-hook';
import type { ClaudeSession } from '../claude-session-registry';
import { settleClaudeWakeHold } from './claude-provider-cleanup';

type SettleParams = Parameters<typeof settleClaudeWakeHold>[0];

/** A session that never entered the registry, so disposal's identity guards all read "not mine"
 * and the only observable step is the provider iterator being returned. */
const fakeSession = (
  onProviderReturn?: () => void,
  queueClosed = false,
  stopHook: TaskStopHook | null = null,
): ClaudeSession =>
  ({
    subChatId: 'settling-chat',
    stopHook,
    queue: { closed: queueClosed, close: () => {} },
    query: {
      return: async () => {
        onProviderReturn?.();
        return { done: true, value: undefined };
      },
    },
    turnSettled: null,
  }) as unknown as ClaudeSession;

const settleParams = (
  resources: SettleParams['resources'],
  overrides: Partial<SettleParams> = {},
): SettleParams => ({
  exit: { reason: 'work-finished', bursts: 1 },
  resources,
  subChatId: 'settling-chat',
  session: fakeSession(),
  executionContextId: undefined,
  io: { clearPendingApprovals: vi.fn(), clearCurrentExecutionChat: vi.fn() },
  retractIfCurrent: vi.fn(),
  dropIfCurrent: vi.fn(),
  takeCutShortBurst: () => null,
  ...overrides,
});

describe('settleClaudeWakeHold', () => {
  it('releases each hold resource exactly once when settlement runs twice', async () => {
    const releaseFlowResourceActivity = vi.fn();
    const releaseRuntimeSlot = vi.fn();
    const unregisterFlowRunAbort = vi.fn();
    const params = settleParams({
      releaseFlowResourceActivity,
      releaseRuntimeSlot,
      unregisterFlowRunAbort,
    });

    await settleClaudeWakeHold(params);
    await settleClaudeWakeHold(params);

    expect(releaseFlowResourceActivity).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeSlot).toHaveBeenCalledTimes(1);
    expect(unregisterFlowRunAbort).toHaveBeenCalledTimes(1);
  });

  it('holds flow-activity release until a cancellation attached mid-settlement persists', async () => {
    let persistCancellation!: () => void;
    const releaseFlowResourceActivity = vi.fn();
    const resources: SettleParams['resources'] = { releaseFlowResourceActivity };
    // A Stop landing while provider cleanup awaits — the last window in which durable cancellation
    // work can still be owed once the first drain has already passed.
    const params = settleParams(resources, {
      session: fakeSession(() => {
        resources.cancellationPersistence = new Promise<void>((resolve) => {
          persistCancellation = resolve;
        });
      }),
    });

    const settling = settleClaudeWakeHold(params);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseFlowResourceActivity).not.toHaveBeenCalled();

    persistCancellation();
    await settling;
    expect(releaseFlowResourceActivity).toHaveBeenCalledTimes(1);
  });

  it('hands a disposal failure to the activity release rather than swallowing it', async () => {
    const releaseFlowResourceActivity = vi.fn();
    const disposalError = new Error('provider iterator refused to return');
    const params = settleParams(
      { releaseFlowResourceActivity },
      {
        session: fakeSession(() => {
          throw disposalError;
        }),
      },
    );

    await expect(settleClaudeWakeHold(params)).rejects.toBe(disposalError);
    // Admission retains the capacity when cleanup failed: a successor must not be admitted onto a
    // slot whose predecessor may still be running.
    expect(releaseFlowResourceActivity).toHaveBeenCalledWith(disposalError);
  });
});

describe('settleClaudeWakeHold — reporting the background work a pump exit drops', () => {
  const liveWork: StopPendingWork = {
    backgroundTasks: [
      { id: 't1', type: 'shell', status: 'running', description: 'long verification run' },
    ],
    sessionCrons: [],
  };
  const stopHook: TaskStopHook = Object.assign(async () => ({}), {
    reset: () => {},
    lastPendingWork: liveWork,
  });

  beforeEach(() => {
    vi.mocked(captureMainMessage).mockClear();
  });

  it('names the exit that killed the tasks when this cleanup is the one closing stdin', async () => {
    await settleClaudeWakeHold(
      settleParams(
        {},
        { exit: { reason: 'stream-ended' }, session: fakeSession(undefined, false, stopHook) },
      ),
    );

    expect(captureMainMessage).toHaveBeenCalledWith(
      'Session disposed with pending background work',
      'warning',
      { subChatId: 'settling-chat', cause: 'wake-pump-exit:stream-ended', kinds: 'shell' },
    );
  });

  it('stays silent when a release already closed stdin, so one kill is not counted twice', async () => {
    await settleClaudeWakeHold(
      settleParams(
        {},
        { exit: { reason: 'stream-ended' }, session: fakeSession(undefined, true, stopHook) },
      ),
    );

    expect(captureMainMessage).not.toHaveBeenCalled();
  });

  it('stays silent when the session was handed to a turn rather than killed', async () => {
    await settleClaudeWakeHold(
      settleParams(
        {},
        { exit: { reason: 'turn-taken-over' }, session: fakeSession(undefined, false, stopHook) },
      ),
    );

    expect(captureMainMessage).not.toHaveBeenCalled();
  });
});

// The renderer plays the failure sound for a wait that died; Stop and release retract earlier,
// and a clean or interrupted end must never be mistaken for a crash.
describe('settleClaudeWakeHold — naming a failed wait', () => {
  it.each([
    [{ reason: 'stream-ended' }, 'failed'],
    [{ reason: 'sink-error', error: new Error('sink') }, 'failed'],
    [{ reason: 'work-finished', bursts: 1 }, undefined],
    [{ reason: 'interrupted' }, undefined],
  ] as const)('retracts a %o exit with endReason %s', async (exit, endReason) => {
    const retractIfCurrent = vi.fn();
    await settleClaudeWakeHold(settleParams({}, { exit, retractIfCurrent })).catch(() => {});
    expect(retractIfCurrent).toHaveBeenCalledExactlyOnceWith(endReason);
  });
});
