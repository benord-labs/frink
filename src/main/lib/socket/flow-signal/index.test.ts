import { beforeEach, describe, expect, it, vi } from 'vitest';

const taskMocks = vi.hoisted(() => ({
  getFlowDriveInfoForSubChat: vi.fn(),
  getLatestFlowTaskForSubChat: vi.fn(),
  getTaskById: vi.fn(),
}));
const runMocks = vi.hoisted(() => ({
  getNewestFlowRunForSubChat: vi.fn(),
  isFlowRunSignalDead: vi.fn(),
}));
const resumeMocks = vi.hoisted(() => ({
  isRunRestartInterrupted: vi.fn(),
}));
const captureMainException = vi.hoisted(() => vi.fn());

vi.mock('../../db', () => ({ getDatabase: vi.fn(() => 'db') }));
vi.mock('../../db/repos/tasks', () => ({
  ...taskMocks,
  isTerminalFinalTaskStatus: (status: string) =>
    ['done', 'completed', 'cancelled'].includes(status),
}));
vi.mock('../../db/repos/flow-runs', () => runMocks);
vi.mock('../../flows/resume', () => resumeMocks);
vi.mock('../../sentry/init', () => ({ captureMainException }));
vi.mock('electron-log', () => ({
  default: { warn: vi.fn() },
}));

import {
  finalizeFlowSignalBeforeSessionDisposition,
  requiresStrictSignalFinalization,
  resolveFlowSignalArming,
} from '.';

beforeEach(() => {
  vi.clearAllMocks();
  taskMocks.getFlowDriveInfoForSubChat.mockResolvedValue({
    active: false,
    autoApprovePlan: false,
    taskId: null,
  });
  taskMocks.getLatestFlowTaskForSubChat.mockResolvedValue(null);
  taskMocks.getTaskById.mockResolvedValue(null);
  runMocks.isFlowRunSignalDead.mockResolvedValue(false);
  runMocks.getNewestFlowRunForSubChat.mockResolvedValue(null);
  resumeMocks.isRunRestartInterrupted.mockResolvedValue(false);
});

describe('resolveFlowSignalArming durable provenance', () => {
  it('returns the durable Flow task and run provenance', async () => {
    const task = { id: 'flow-task', status: 'running', source: 'flow', flowRunId: 'flow-run' };
    taskMocks.getFlowDriveInfoForSubChat.mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: task.id,
    });
    taskMocks.getTaskById.mockResolvedValueOnce(task);
    runMocks.getNewestFlowRunForSubChat.mockResolvedValueOnce({
      id: 'flow-run',
      status: 'running',
    });

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      liveFlowRunId: 'flow-run',
      isFlowDrivenExecution: true,
      effectiveSignalTaskId: task.id,
      prefetchedSignalTask: task,
      restartInterruptedFlowRunId: null,
      provenanceLookupError: null,
    });
  });

  describe('liveFlowRunId: the run that can still speak in the chat, or null', () => {
    const lastStep = (flowRunId = 'run-1') => ({ id: 'last-step', status: 'done', flowRunId });
    /** A chat whose newest flow task is done, with `newest` as the run that owns the chat. */
    const liveAfterLastStep = async (newest: { id: string; status: string } | null) => {
      taskMocks.getLatestFlowTaskForSubChat.mockResolvedValueOnce(lastStep());
      runMocks.getNewestFlowRunForSubChat.mockResolvedValueOnce(newest);
      return (await resolveFlowSignalArming('flow-chat', 'last-step')).liveFlowRunId;
    };

    it('is true while the owning run has not ended, including between two steps', async () => {
      for (const status of ['running', 'paused', 'failed']) {
        expect(await liveAfterLastStep({ id: 'run-1', status })).toBe('run-1');
      }
    });

    it('is false once the owning run has completed or been cancelled', async () => {
      expect(await liveAfterLastStep({ id: 'run-1', status: 'completed' })).toBeNull();
      expect(await liveAfterLastStep({ id: 'run-1', status: 'cancelled' })).toBeNull();
    });

    it('is false when the run is gone, even for a task still in a driving status', async () => {
      expect(await liveAfterLastStep(null)).toBeNull();
      taskMocks.getFlowDriveInfoForSubChat.mockResolvedValueOnce({
        active: true,
        autoApprovePlan: false,
        taskId: 'orphan-step',
      });
      const armed = await resolveFlowSignalArming('orphan-chat', 'orphan-step');
      expect(armed).toMatchObject({ isFlowDrivenExecution: true, liveFlowRunId: null });
    });

    describe('a restart-interrupted step being revived', () => {
      const interrupted = () => {
        taskMocks.getLatestFlowTaskForSubChat.mockResolvedValueOnce({
          id: 'cut-step',
          status: 'cancelled',
          flowRunId: 'cut-run',
        });
        resumeMocks.isRunRestartInterrupted.mockResolvedValueOnce(true);
      };
      const liveWith = async (newest: { id: string; status: string } | null) => {
        interrupted();
        runMocks.getNewestFlowRunForSubChat.mockResolvedValueOnce(newest);
        return (await resolveFlowSignalArming('restart-chat', 'pinned-task')).liveFlowRunId;
      };

      it('counts its own cancelled run as live', async () => {
        expect(await liveWith({ id: 'cut-run', status: 'cancelled' })).toBe('cut-run');
      });

      it('does not, once that run has been deleted', async () => {
        expect(await liveWith(null)).toBeNull();
      });

      it('does not override a newer run on a reused chat that has already ended', async () => {
        expect(await liveWith({ id: 'newer-run', status: 'completed' })).toBeNull();
      });

      it('names the newer run, not its own, when that newer run is the live one', async () => {
        expect(await liveWith({ id: 'newer-run', status: 'running' })).toBe('newer-run');
      });
    });

    it('never queries for a chat with no flow task, which stays untagged', async () => {
      expect((await resolveFlowSignalArming('ordinary-chat', null)).liveFlowRunId).toBeNull();
      expect((await resolveFlowSignalArming(undefined, null)).liveFlowRunId).toBeNull();
      expect(runMocks.getNewestFlowRunForSubChat).not.toHaveBeenCalled();
    });

    it('treats a failed read as not live, without failing the turn', async () => {
      taskMocks.getLatestFlowTaskForSubChat.mockResolvedValueOnce(lastStep());
      runMocks.getNewestFlowRunForSubChat.mockRejectedValueOnce(new Error('db read failed'));
      const armed = await resolveFlowSignalArming('flow-chat', 'last-step');
      expect(armed).toMatchObject({ liveFlowRunId: null, provenanceLookupError: null });
      expect(captureMainException).toHaveBeenCalledWith(expect.any(Error), {
        surface: 'flow-run-live',
      });
    });
  });

  it('keeps a healthy ordinary task distinct from unknown provenance', async () => {
    const task = { id: 'chat-task', status: 'running', source: 'chat', flowRunId: null };
    taskMocks.getTaskById.mockResolvedValueOnce(task);

    await expect(resolveFlowSignalArming('ordinary-chat', task.id)).resolves.toMatchObject({
      isFlowDrivenExecution: false,
      prefetchedSignalTask: task,
      restartInterruptedFlowRunId: null,
      provenanceLookupError: null,
    });
  });

  it('carries restart-interrupted Flow provenance without reviving it yet', async () => {
    taskMocks.getLatestFlowTaskForSubChat.mockResolvedValueOnce({
      id: 'cancelled-flow-task',
      status: 'cancelled',
      flowRunId: 'interrupted-run',
    });
    resumeMocks.isRunRestartInterrupted.mockResolvedValueOnce(true);
    // Another window may revive the row before this read; provenance keeps the detected status.
    taskMocks.getTaskById.mockResolvedValueOnce({ id: 'cancelled-flow-task', status: 'running' });
    runMocks.getNewestFlowRunForSubChat.mockResolvedValueOnce({
      id: 'interrupted-run',
      status: 'cancelled',
    });

    await expect(resolveFlowSignalArming('restart-chat', 'pinned-task')).resolves.toMatchObject({
      effectiveSignalTaskId: 'cancelled-flow-task',
      prefetchedSignalTask: null,
      restartInterruptedFlowRunId: 'interrupted-run',
      liveFlowRunId: 'interrupted-run',
      revivedTask: { id: 'cancelled-flow-task', status: 'cancelled' },
      provenanceLookupError: null,
    });
  });

  it('records a DB fault as unknown provenance instead of ordinary provenance', async () => {
    const error = new Error('drive lookup failed');
    taskMocks.getFlowDriveInfoForSubChat.mockRejectedValueOnce(error);

    const armed = await resolveFlowSignalArming('unknown-chat', 'pinned-task');

    expect(armed.isFlowDrivenExecution).toBe(false);
    expect(armed.provenanceLookupError).toEqual({ cause: error });
    expect(captureMainException).toHaveBeenCalledWith(error, {
      surface: 'flow-signal-arming',
    });
  });

  it('keeps a thrown null distinct from successful ordinary provenance', async () => {
    taskMocks.getFlowDriveInfoForSubChat.mockRejectedValueOnce(null);

    await expect(resolveFlowSignalArming('null-error-chat', 'pinned-task')).resolves.toMatchObject({
      provenanceLookupError: { cause: null },
    });
  });

  // Concurrent arming must keep reading the mocked db modules. Fails if the db-layer imports move
  // back to `await import(...)`: the second in-flight call then resolves the real module, whose
  // test guard raises a fault that aborts that turn.
  it('arms both turns cleanly when two sub-chats resolve concurrently', async () => {
    const [first, second] = await Promise.all([
      resolveFlowSignalArming('concurrent-chat-a', null),
      resolveFlowSignalArming('concurrent-chat-b', null),
    ]);

    expect(first.provenanceLookupError).toBeNull();
    expect(second.provenanceLookupError).toBeNull();
    expect(captureMainException).not.toHaveBeenCalled();
  });
});

describe('requiresStrictSignalFinalization', () => {
  const ordinary = {
    isFlowDrivenExecution: false,
    restartInterruptedFlowRunId: null,
    provenanceLookupError: null,
  } as Parameters<typeof requiresStrictSignalFinalization>[0];

  it('keeps proven ordinary execution on best-effort finalization', () => {
    expect(requiresStrictSignalFinalization(ordinary)).toBe(false);
  });

  it.each([
    { ...ordinary, isFlowDrivenExecution: true },
    { ...ordinary, restartInterruptedFlowRunId: 'interrupted-run' },
    { ...ordinary, provenanceLookupError: { cause: new Error('lookup failed') } },
  ])('requires strict finalization for $isFlowDrivenExecution provenance', (armed) => {
    expect(requiresStrictSignalFinalization(armed)).toBe(true);
  });
});

describe('finalizeFlowSignalBeforeSessionDisposition', () => {
  it('disposes the session before returning a persistence failure', async () => {
    const persistenceError = new Error('signal persistence failed');
    const dispose = vi.fn(async () => undefined);

    const failure = await finalizeFlowSignalBeforeSessionDisposition(
      Promise.reject(persistenceError),
      dispose,
    );

    expect(dispose).toHaveBeenCalledOnce();
    expect(failure).toEqual({ cause: persistenceError });
  });

  it('preserves both persistence and disposition failures', async () => {
    const persistenceError = new Error('signal persistence failed');
    const dispositionError = new Error('session disposition failed');

    const failure = finalizeFlowSignalBeforeSessionDisposition(
      Promise.reject(persistenceError),
      async () => {
        throw dispositionError;
      },
    );

    await expect(failure).rejects.toMatchObject({
      errors: [persistenceError, dispositionError],
    });
  });

  it('throws a disposition-only failure into the execution error path', async () => {
    const dispositionError = new Error('session disposition failed');

    await expect(
      finalizeFlowSignalBeforeSessionDisposition(Promise.resolve(), async () => {
        throw dispositionError;
      }),
    ).rejects.toBe(dispositionError);
  });
});
