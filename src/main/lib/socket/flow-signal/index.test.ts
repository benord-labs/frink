import { beforeEach, describe, expect, it, vi } from 'vitest';

const taskMocks = vi.hoisted(() => ({
  getFlowDriveInfoForSubChat: vi.fn(),
  getLatestFlowTaskForSubChat: vi.fn(),
  getTaskById: vi.fn(),
}));
const runMocks = vi.hoisted(() => ({
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
const setDispatchStartedMarker = vi.hoisted(() => vi.fn());
const clearDispatchStartedMarker = vi.hoisted(() => vi.fn(async () => ({ id: 'ship-task' })));
vi.mock('../../db/repos/task-parking/dispatch-marker', async (orig) => ({
  ...(await orig<typeof import('../../db/repos/task-parking/dispatch-marker')>()),
  setDispatchStartedMarker,
  clearDispatchStartedMarker,
}));
vi.mock('../../sentry/init', () => ({ captureMainException, captureMainMessage: vi.fn() }));
vi.mock('electron-log', () => ({
  default: { warn: vi.fn() },
}));

import { isTaskBeingDelivered } from '../../task-executor/dispatch-registry';
import {
  abortReplacedTurn,
  recordDispatchTurnStart,
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

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      isFlowDrivenExecution: true,
      effectiveSignalTaskId: task.id,
      prefetchedSignalTask: task,
      restartInterruptedFlowRunId: null,
      provenanceLookupError: null,
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

    await expect(resolveFlowSignalArming('restart-chat', 'pinned-task')).resolves.toMatchObject({
      effectiveSignalTaskId: 'cancelled-flow-task',
      prefetchedSignalTask: null,
      restartInterruptedFlowRunId: 'interrupted-run',
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

// sc-2775: an operator turn typed while a flow step's prompt was still undelivered got armed against
// that step, and its `done` completed a step that never ran.
describe('resolveFlowSignalArming — undelivered flow dispatch', () => {
  const DISPATCHED_AT = '2026-10-02T10:30:13.000Z';

  function driveTask(result: Record<string, unknown>) {
    const task = {
      id: 'ship-task',
      status: 'running',
      source: 'flow',
      flowRunId: 'flow-run',
      result,
    };
    taskMocks.getFlowDriveInfoForSubChat.mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: task.id,
    });
    taskMocks.getTaskById.mockResolvedValueOnce(task);
    return task;
  }

  it('disarms a turn the step did not send while its dispatch is undelivered', async () => {
    driveTask({ dispatchedAt: DISPATCHED_AT });

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      isFlowDrivenExecution: true,
      effectiveSignalTaskId: 'ship-task',
      taskSignalDisarmed: true,
      undeliveredDispatchTaskId: 'ship-task',
    });
  });

  it("arms the step's own dispatched turn", async () => {
    driveTask({ dispatchedAt: DISPATCHED_AT });

    await expect(
      resolveFlowSignalArming('flow-chat', 'pinned-task', {
        taskId: 'ship-task',
        dispatchedAt: DISPATCHED_AT,
      }),
    ).resolves.toMatchObject({ taskSignalDisarmed: false, undeliveredDispatchTaskId: null });
  });

  it("disarms an earlier attempt's turn of the same step (retry or re-claim since)", async () => {
    driveTask({ dispatchedAt: DISPATCHED_AT });

    await expect(
      resolveFlowSignalArming('flow-chat', 'pinned-task', {
        taskId: 'ship-task',
        dispatchedAt: '2026-10-02T09:00:00.000Z',
      }),
    ).resolves.toMatchObject({ taskSignalDisarmed: true, undeliveredDispatchTaskId: 'ship-task' });
  });

  it('arms a follow-up reply once the dispatch has started a turn', async () => {
    driveTask({ dispatchedAt: DISPATCHED_AT, dispatchStartedAt: '2026-10-02T10:30:20.000Z' });

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null,
    });
  });

  it('arms a follow-up when the clock stepped back between dispatch and start', async () => {
    driveTask({ dispatchedAt: DISPATCHED_AT, dispatchStartedAt: '2026-10-02T10:30:11.000Z' });

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null,
    });
  });

  it('fails open for a row stamped before the dispatch marker existed', async () => {
    driveTask({ subChatId: 'flow-chat' });

    await expect(resolveFlowSignalArming('flow-chat', 'pinned-task')).resolves.toMatchObject({
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null,
    });
  });
});

describe('recordDispatchTurnStart (sc-2775)', () => {
  const SHIP_DISPATCH = { taskId: 'ship-task', dispatchedAt: '2026-10-02T10:30:13.000Z' };
  const armedTurn = () => ({
    taskSignalDisarmed: false,
    undeliveredDispatchTaskId: null as string | null,
  });
  beforeEach(() => setDispatchStartedMarker.mockResolvedValue({ id: 'ship-task' }));

  it('disarms a dispatched turn whose attempt was superseded before its stamp landed', async () => {
    setDispatchStartedMarker.mockResolvedValueOnce(null);
    const armed = armedTurn();

    await recordDispatchTurnStart(armed, SHIP_DISPATCH, 'sub');

    expect(armed).toEqual({ taskSignalDisarmed: true, undeliveredDispatchTaskId: 'ship-task' });
  });

  it('never stamps a turn already replaced (aborted) before it got going', async () => {
    const controller = new AbortController();
    controller.abort();
    const armed = armedTurn();

    await recordDispatchTurnStart(armed, SHIP_DISPATCH, 'sub', controller.signal);

    expect(setDispatchStartedMarker).not.toHaveBeenCalled();
    expect(armed.taskSignalDisarmed).toBe(true);
  });

  it('undoes the stamp when the turn is replaced while the stamp is in flight', async () => {
    const controller = new AbortController();
    setDispatchStartedMarker.mockImplementationOnce(async () => {
      controller.abort();
      return { id: 'ship-task' };
    });
    const armed = armedTurn();

    await recordDispatchTurnStart(armed, SHIP_DISPATCH, 'sub', controller.signal);

    const stampedAt = setDispatchStartedMarker.mock.calls[0]?.[3];
    expect(clearDispatchStartedMarker).toHaveBeenCalledWith(
      'db',
      'ship-task',
      SHIP_DISPATCH.dispatchedAt,
      stampedAt,
    );
    expect(armed.taskSignalDisarmed).toBe(true);
  });

  // Replaced, paused or stopped later: the step's prompt was interrupted, so it is not delivered.
  it('undoes exactly its own stamp when the dispatched turn is aborted later', async () => {
    const controller = new AbortController();
    await recordDispatchTurnStart(armedTurn(), SHIP_DISPATCH, 'sub', controller.signal);
    expect(clearDispatchStartedMarker).not.toHaveBeenCalled();

    controller.abort();

    expect(clearDispatchStartedMarker).toHaveBeenCalledWith(
      'db',
      'ship-task',
      SHIP_DISPATCH.dispatchedAt,
      setDispatchStartedMarker.mock.calls[0]?.[3],
    );
  });

  it('keeps a dispatched turn armed once its stamp lands', async () => {
    const armed = armedTurn();
    await recordDispatchTurnStart(armed, SHIP_DISPATCH, 'sub');
    expect(armed.taskSignalDisarmed).toBe(false);
  });

  it("stamps the dispatching task's turn as started", async () => {
    await recordDispatchTurnStart(armedTurn(), SHIP_DISPATCH, 'sub');
    expect(setDispatchStartedMarker).toHaveBeenCalledWith(
      'db',
      'ship-task',
      SHIP_DISPATCH.dispatchedAt,
      expect.any(String),
    );
  });

  it('stamps nothing for a user turn', async () => {
    await recordDispatchTurnStart(
      { taskSignalDisarmed: true, undeliveredDispatchTaskId: 'ship-task' },
      undefined,
      'sub',
    );
    expect(setDispatchStartedMarker).not.toHaveBeenCalled();
  });

  it('never throws when the stamp fails — the turn must still run', async () => {
    setDispatchStartedMarker.mockRejectedValueOnce(new Error('db busy'));
    const armed = armedTurn();
    await expect(recordDispatchTurnStart(armed, SHIP_DISPATCH, 'sub')).resolves.toBeUndefined();
    expect(captureMainException).toHaveBeenCalled();
    // Fail closed: a turn whose delivery could not be recorded cannot complete the step.
    expect(armed.taskSignalDisarmed).toBe(true);
  });
});

// An operator turn armed off the step's start stamp, then replaces (aborts) the step's own turn:
// the step was interrupted, so the replacing turn must not complete it.
describe('abortReplacedTurn (sc-2775)', () => {
  const SHIP = { taskId: 'ship-task', dispatchedAt: '2026-10-02T10:30:13.000Z' };
  beforeEach(() => setDispatchStartedMarker.mockResolvedValue({ id: 'ship-task' }));

  it("disarms a turn that replaces the step's own dispatched turn", async () => {
    const delivering = new AbortController();
    await recordDispatchTurnStart(
      { taskSignalDisarmed: false, undeliveredDispatchTaskId: null },
      SHIP,
      'sub',
      delivering.signal,
    );
    const operator = {
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null as string | null,
    };

    abortReplacedTurn(operator, delivering, undefined);

    expect(operator).toEqual({ taskSignalDisarmed: true, undeliveredDispatchTaskId: 'ship-task' });
    expect(delivering.signal.aborted).toBe(true);
  });

  it('lets a resend of the same step take over the delivery, armed', async () => {
    const delivering = new AbortController();
    await recordDispatchTurnStart(
      { taskSignalDisarmed: false, undeliveredDispatchTaskId: null },
      SHIP,
      'sub',
      delivering.signal,
    );
    const resend = { taskSignalDisarmed: false, undeliveredDispatchTaskId: null as string | null };

    abortReplacedTurn(resend, delivering, SHIP);

    expect(resend.taskSignalDisarmed).toBe(false);
  });

  it("reports the sub-chat's live turn as delivering its step, synchronously, from before its stamp lands", async () => {
    const { _registerExecutionForTests, _clearActiveExecutionsForTests } =
      await import('../streaming/execution-registry');
    const delivering = new AbortController();
    _registerExecutionForTests('sub-live', delivering);
    let duringStamp = false;
    setDispatchStartedMarker.mockImplementationOnce(async () => {
      duringStamp = isTaskBeingDelivered('ship-task', 'sub-live');
      return { id: 'ship-task' };
    });

    await recordDispatchTurnStart(
      { taskSignalDisarmed: false, undeliveredDispatchTaskId: null },
      SHIP,
      'sub-live',
      delivering.signal,
    );

    expect(duringStamp).toBe(true);
    expect(isTaskBeingDelivered('other-task', 'sub-live')).toBe(false);
    _clearActiveExecutionsForTests();
  });

  // Two steps can share a reused sub-chat: B's own proven dispatch is B's, whatever it replaces.
  it("leaves a different step's proven dispatched turn armed when it replaces this step's", async () => {
    const delivering = new AbortController();
    await recordDispatchTurnStart(
      { taskSignalDisarmed: false, undeliveredDispatchTaskId: null },
      SHIP,
      'sub',
      delivering.signal,
    );
    const nextStep = {
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null as string | null,
    };

    abortReplacedTurn(nextStep, delivering, { taskId: 'next-task', dispatchedAt: 'gen-next' });

    expect(nextStep.taskSignalDisarmed).toBe(false);
  });

  it('leaves a turn replacing an ordinary turn armed', () => {
    const operator = {
      taskSignalDisarmed: false,
      undeliveredDispatchTaskId: null as string | null,
    };
    const ordinary = new AbortController();
    abortReplacedTurn(operator, ordinary, undefined);
    expect(operator.taskSignalDisarmed).toBe(false);
    expect(ordinary.signal.aborted).toBe(true);
  });
});
