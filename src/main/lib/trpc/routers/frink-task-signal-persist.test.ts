import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { TaskResultRecord } from '../../db/repos/tasks';

const mockGetTaskById = vi.fn();
const mockUpdateTaskStatus = vi.fn();
const mockUpdateTaskResult = vi.fn();
const mockBroadcastTaskSignalPersisted = vi.fn();
const mockCaptureMainException = vi.hoisted(() => vi.fn());
const mockCaptureMainMessage = vi.hoisted(() => vi.fn());

vi.mock('../../sentry/init', () => ({
  captureMainException: mockCaptureMainException,
  captureMainMessage: mockCaptureMainMessage,
}));

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../../db/repos/tasks', () => ({
  getTaskById: (...args: unknown[]) => mockGetTaskById(...args),
  updateTaskStatus: (...args: unknown[]) => mockUpdateTaskStatus(...args),
  updateTaskResult: (...args: unknown[]) => mockUpdateTaskResult(...args),
  parseResultRecord: (result: TaskResultRecord | null | undefined) => result ?? {},
}));

vi.mock('../../socket/client', () => ({
  broadcastTaskSignalPersisted: (...args: unknown[]) => mockBroadcastTaskSignalPersisted(...args),
}));

const mockGetLatestTaskSignal = vi.fn();
vi.mock('../../mcp/dynamic-chat-server', () => ({
  getLatestTaskSignal: (...args: unknown[]) => mockGetLatestTaskSignal(...args),
}));

const mockUnparkQuietIdleFlowRun = vi.fn();
vi.mock('../../flows/task-completion-watcher', () => ({
  unparkQuietIdleFlowRun: (...args: unknown[]) => mockUnparkQuietIdleFlowRun(...args),
}));

const mockSetQuietEndMarker = vi.fn();
const mockRemoveQuietEndMarker = vi.fn();
const mockReplaceWakeResumedRow = vi.fn();
vi.mock('../../db/repos/task-parking/quiet-marker', () => ({
  setQuietEndMarker: (...args: unknown[]) => mockSetQuietEndMarker(...args),
  removeQuietEndMarker: (...args: unknown[]) => mockRemoveQuietEndMarker(...args),
  replaceWakeResumedRow: (...args: unknown[]) => mockReplaceWakeResumedRow(...args),
}));

import {
  clearLinkedTaskQuietEnd,
  finalizeLinkedTaskSignalFromContext,
  hasLatestTaskSignalFor,
  markLinkedTaskQuietEnd,
  markQuietEndIfUnsignaled,
  persistLinkedTaskSignal,
  recordLinkedTaskSignal,
  suppressQuietEndForPlanTurn,
} from './frink-task-signal-persist';

describe('finalizeLinkedTaskSignalFromContext', () => {
  const params = {
    taskIdForExecution: 't1',
    executionContextId: 'ctx-1',
    shouldMarkQuietEnd: true,
    isAborted: () => false,
    subChatId: 'chat-1',
  };

  beforeEach(() => {
    mockCaptureMainException.mockReset();
    mockGetLatestTaskSignal.mockReset();
    mockSetQuietEndMarker.mockReset();
    mockGetLatestTaskSignal.mockReturnValue(undefined);
    mockSetQuietEndMarker.mockRejectedValue(new Error('quiet marker failed'));
  });

  it('keeps ordinary-chat finalization best effort by default', async () => {
    await expect(finalizeLinkedTaskSignalFromContext(params)).resolves.toBeUndefined();
    expect(mockCaptureMainException).toHaveBeenCalledOnce();
  });

  it('surfaces finalization errors when Flow settlement requests them', async () => {
    await expect(
      finalizeLinkedTaskSignalFromContext({ ...params, throwOnError: true }),
    ).rejects.toThrow('quiet marker failed');
    expect(mockCaptureMainException).not.toHaveBeenCalled();
  });

  it('writes the quiet-end marker when the turn ends with no recorded signal', async () => {
    // Every provider reaches here post-stream, independent of whether the dynamic-chat MCP
    // mounted: without the marker the flows sweep never parks the task and it stays running.
    mockSetQuietEndMarker.mockResolvedValue({ id: 't1' });
    await expect(finalizeLinkedTaskSignalFromContext(params)).resolves.toBeUndefined();
    expect(mockSetQuietEndMarker).toHaveBeenCalledWith({}, 't1', expect.any(String));
  });

  describe('a recorded signal the task row refuses (sc-2771)', () => {
    const done: TaskSignalPayload = {
      state: 'done',
      summary: 'Shipped',
      at: '2026-09-04T10:30:05Z',
    };

    beforeEach(() => {
      mockCaptureMainMessage.mockReset();
      mockUpdateTaskStatus.mockReset();
      mockGetLatestTaskSignal.mockReturnValue(done);
      // Already settled: neither the primary CAS nor a park supersede can take the signal.
      mockGetTaskById.mockReset().mockResolvedValue({
        id: 't1',
        status: 'cancelled',
        flowRunId: 'run-1',
        result: {},
      });
    });

    it('fails a strict (flow) finalization instead of settling it as a success', async () => {
      await expect(
        finalizeLinkedTaskSignalFromContext({ ...params, throwOnError: true }),
      ).rejects.toThrow('Task signal dropped: done on task t1 (status cancelled)');
      expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    });

    it('reports a warning on an ordinary turn and still settles', async () => {
      await expect(finalizeLinkedTaskSignalFromContext(params)).resolves.toBeUndefined();
      expect(mockCaptureMainMessage).toHaveBeenCalledWith(
        'Task signal dropped at turn end',
        'warning',
        expect.objectContaining({ taskId: 't1', state: 'done', status: 'cancelled' }),
      );
    });

    // A wake-burst settle (or a question park) may already have written this exact signal; the
    // turn-end re-persist then finds a terminal row and returns false. That is not a drop.
    it.each([
      ['done', 'done'],
      ['needs_attention', 'awaiting_input'],
    ] as const)(
      'treats a %s row already carrying this exact signal as applied, not dropped',
      async (status, state) => {
        const signal: TaskSignalPayload = {
          state,
          summary: 'Same one',
          at: '2026-09-04T10:30:05Z',
        };
        mockGetLatestTaskSignal.mockReturnValue(signal);
        mockGetTaskById.mockResolvedValue({
          id: 't1',
          status,
          flowRunId: 'run-1',
          result: { agentSignal: signal },
        });
        await expect(
          finalizeLinkedTaskSignalFromContext({ ...params, throwOnError: true }),
        ).resolves.toBeUndefined();
        await expect(finalizeLinkedTaskSignalFromContext(params)).resolves.toBeUndefined();
        expect(mockCaptureMainMessage).not.toHaveBeenCalled();
      },
    );

    it('still reports a drop when the row carries a DIFFERENT (older) signal', async () => {
      mockGetTaskById.mockResolvedValue({
        id: 't1',
        status: 'done',
        flowRunId: 'run-1',
        result: { agentSignal: { ...done, at: '2026-09-04T09:37:40Z' } },
      });
      await expect(
        finalizeLinkedTaskSignalFromContext({ ...params, throwOnError: true }),
      ).rejects.toThrow('Task signal dropped');
    });

    it('stays quiet when the signal is persisted', async () => {
      mockGetTaskById.mockResolvedValue({
        id: 't1',
        status: 'running',
        flowRunId: null,
        result: {},
      });
      mockUpdateTaskStatus.mockResolvedValue({ id: 't1' });
      await expect(
        finalizeLinkedTaskSignalFromContext({ ...params, throwOnError: true }),
      ).resolves.toBeUndefined();
      expect(mockCaptureMainMessage).not.toHaveBeenCalled();
    });
  });

  it('skips the quiet-end marker on a plan-terminal turn', async () => {
    // The plan card (or halted submission) is that turn's terminal artifact, not a quiet wait — a
    // marker here would make the renderer's completion policy defer plan_ready to the park sweep.
    await expect(
      finalizeLinkedTaskSignalFromContext({ ...params, planTerminal: true }),
    ).resolves.toBeUndefined();
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });
});

describe('suppressQuietEndForPlanTurn', () => {
  const turn = (halt: boolean, locked: boolean) => ({
    planSubmissionHalt: () => halt,
    planTerminalsLocked: locked,
  });
  const pending = { backgroundTasks: [{ id: 'a1', type: 'subagent' }], sessionCrons: [] };

  it('suppresses for a halted submission and for a locked stop with nothing pending', () => {
    expect(suppressQuietEndForPlanTurn(turn(true, false), 'plan', null)).toBe(true);
    // The amendment shape: plan file rewritten, no ExitPlanMode, nothing running — the card path
    // owns the transition, so a marker would defer plan_ready forever.
    expect(suppressQuietEndForPlanTurn(turn(false, true), 'plan', null)).toBe(true);
  });

  it('keeps the marker for a held drafting wait — the wake pump owns that end', () => {
    expect(suppressQuietEndForPlanTurn(turn(false, true), 'plan', pending)).toBe(false);
  });

  it('never suppresses for agent-mode Claude turns', () => {
    expect(suppressQuietEndForPlanTurn(turn(false, false), 'agent', null)).toBe(false);
    expect(suppressQuietEndForPlanTurn(turn(false, false), 'agent', pending)).toBe(false);
  });

  it('suppresses for every non-Claude plan turn and no other non-Claude turn', () => {
    // Codex has no wake pump: a plan turn's quiet end never means 'waiting', and the marker
    // would defer the plan card's plan_ready transition to the park sweep.
    expect(suppressQuietEndForPlanTurn(null, 'plan', null)).toBe(true);
    expect(suppressQuietEndForPlanTurn(undefined, 'plan', null)).toBe(true);
    expect(suppressQuietEndForPlanTurn(null, 'agent', null)).toBe(false);
  });
});

describe('clearLinkedTaskQuietEnd', () => {
  beforeEach(() => {
    mockGetTaskById.mockReset();
    mockRemoveQuietEndMarker.mockReset();
  });

  it('reports cleared when the atomic remove matched a running row with a marker', async () => {
    mockRemoveQuietEndMarker.mockResolvedValue({ id: 't1', status: 'running', result: {} });
    await expect(clearLinkedTaskQuietEnd('t1')).resolves.toBe('cleared');
    expect(mockRemoveQuietEndMarker).toHaveBeenCalledWith(expect.anything(), 't1');
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });

  it('reports none for a marker-less running task and parked for a non-running one', async () => {
    mockRemoveQuietEndMarker.mockResolvedValue(null);
    mockGetTaskById.mockResolvedValue({ status: 'running', result: { startMode: 'execute' } });
    await expect(clearLinkedTaskQuietEnd('t1')).resolves.toBe('none');
    mockGetTaskById.mockResolvedValue({ status: 'needs_attention', result: {} });
    await expect(clearLinkedTaskQuietEnd('t1')).resolves.toBe('parked');
  });

  it('reports none when the task row is gone', async () => {
    mockRemoveQuietEndMarker.mockResolvedValue(null);
    mockGetTaskById.mockResolvedValue(null);
    await expect(clearLinkedTaskQuietEnd('t1')).resolves.toBe('none');
  });
});

describe('markQuietEndIfUnsignaled', () => {
  beforeEach(() => {
    mockGetLatestTaskSignal.mockReset();
    mockSetQuietEndMarker.mockReset();
  });

  it('writes nothing when a signal was already recorded this turn', async () => {
    mockGetLatestTaskSignal.mockReturnValue({ state: 'done' });
    await markQuietEndIfUnsignaled('ctx-1', () => false, 't1');
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });

  it('writes nothing when the execution was aborted', async () => {
    mockGetLatestTaskSignal.mockReturnValue(undefined);
    await markQuietEndIfUnsignaled('ctx-1', () => true, 't1');
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });

  it('records the quiet-end marker on a quiet unaborted stop', async () => {
    mockGetLatestTaskSignal.mockReturnValue(undefined);
    mockSetQuietEndMarker.mockResolvedValue({ id: 't1', status: 'running', result: {} });
    await markQuietEndIfUnsignaled('ctx-1', () => false, 't1');
    expect(mockSetQuietEndMarker).toHaveBeenCalledWith(expect.anything(), 't1', expect.any(String));
  });

  it('is phase-blind: any recorded signal suppresses the marker', async () => {
    // Pins the KNOWN asymmetry with the Stop hook's phase-aware read. A non-compliant two-phase
    // turn therefore parks on its stale drafting ask rather than on a quiet-end marker; the node
    // still parks, so it is a wrong-park, not a hang. Narrowing this is a tracked follow-up.
    mockGetLatestTaskSignal.mockReturnValue({ state: 'awaiting_input', summary: 'q', at: 'now' });
    await markQuietEndIfUnsignaled('ctx-1', () => false, 't1');
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });
});

describe('markLinkedTaskQuietEnd', () => {
  beforeEach(() => {
    mockSetQuietEndMarker.mockReset();
  });

  it('returns false when taskIdForExecution is missing', async () => {
    await expect(markLinkedTaskQuietEnd(null)).resolves.toBe(false);
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });

  it('sets the marker via the atomic status-guarded patch', async () => {
    mockSetQuietEndMarker.mockResolvedValue({ id: 't1', status: 'running', result: {} });
    await expect(markLinkedTaskQuietEnd('t1')).resolves.toBe(true);
    expect(mockSetQuietEndMarker).toHaveBeenCalledWith(expect.anything(), 't1', expect.any(String));
  });

  it('returns false when the guarded patch matches no running row', async () => {
    mockSetQuietEndMarker.mockResolvedValue(null);
    await expect(markLinkedTaskQuietEnd('t1')).resolves.toBe(false);
  });

  it('writes nothing when the turn was already aborted', async () => {
    await expect(markLinkedTaskQuietEnd('t1', () => true)).resolves.toBe(false);
    expect(mockSetQuietEndMarker).not.toHaveBeenCalled();
  });
});

describe('persistLinkedTaskSignal', () => {
  const signal: TaskSignalPayload = {
    state: 'awaiting_input',
    summary: 'Need input',
    at: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    mockGetTaskById.mockReset();
    mockUpdateTaskStatus.mockReset();
    mockUpdateTaskResult.mockReset();
    mockBroadcastTaskSignalPersisted.mockReset();
    mockUnparkQuietIdleFlowRun.mockReset();
  });

  it('returns false when taskIdForExecution is missing', async () => {
    await expect(persistLinkedTaskSignal({ taskIdForExecution: undefined, signal })).resolves.toBe(
      false,
    );
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });

  it('returns false when task is missing', async () => {
    mockGetTaskById.mockResolvedValue(null);
    await expect(persistLinkedTaskSignal({ taskIdForExecution: 't1', signal })).resolves.toBe(
      false,
    );
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockBroadcastTaskSignalPersisted).not.toHaveBeenCalled();
  });

  it('returns false when task status cannot accept task signals', async () => {
    mockGetTaskById.mockResolvedValue({ status: 'needs_attention', result: {} });
    await expect(persistLinkedTaskSignal({ taskIdForExecution: 't1', signal })).resolves.toBe(
      false,
    );
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  it('drops a second signal on a step still parked on its own partial — only a resume reopens it (sc-3214)', async () => {
    mockGetTaskById.mockResolvedValue({
      status: 'needs_attention',
      result: {
        agentSignal: { state: 'partial', summary: 'edit denied', at: 'x' },
      },
      flowRunId: 'flow-run-1',
    });
    await expect(
      persistLinkedTaskSignal({
        taskIdForExecution: 't-parked',
        signal: { state: 'done', summary: 'late done', at: 'y' },
      }),
    ).resolves.toBe(false);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockBroadcastTaskSignalPersisted).not.toHaveBeenCalled();
  });

  it('persists, broadcasts, and returns true when task is running', async () => {
    mockGetTaskById.mockResolvedValue({
      status: 'running',
      result: { startMode: 'execute' },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskStatus.mockResolvedValue({ id: 'task-xyz', status: 'needs_attention' });

    await expect(persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal })).resolves.toBe(
      true,
    );

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      'task-xyz',
      'needs_attention',
      expect.objectContaining({
        result: expect.objectContaining({
          agentSignal: signal,
        }),
        // CAS on the pre-checked statuses: a park landing between read and write must win.
        expectStatuses: ['running', 'failed'],
      }),
    );
    expect(mockBroadcastTaskSignalPersisted).toHaveBeenCalledWith({
      taskId: 'task-xyz',
      status: 'needs_attention',
      isFlowLinked: true,
    });
  });

  it('a terminal signal SUPERSEDES a user-pause park that CAS-won against it (completed work is truth)', async () => {
    // Read 1: the turn was still running. CAS write loses — a user-pause park landed in between.
    mockGetTaskById.mockResolvedValueOnce({
      status: 'running',
      result: { startMode: 'execute' },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskStatus.mockResolvedValueOnce(null);
    // Read 2 (fresh): the park row. The supersede write CASes on needs_attention and wins.
    mockGetTaskById.mockResolvedValueOnce({
      status: 'needs_attention',
      result: { startMode: 'execute', userPause: { at: '2026-07-13T00:00:00Z' } },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskStatus.mockResolvedValueOnce({ id: 'task-xyz', status: 'needs_attention' });

    await expect(persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal })).resolves.toBe(
      true,
    );

    const supersedeCall = mockUpdateTaskStatus.mock.calls[1];
    expect(supersedeCall?.[3]).toMatchObject({ expectStatuses: ['needs_attention'] });
    // resolveTaskSignalTransition on the fresh row scrubs the stale userPause marker.
    expect(
      (supersedeCall?.[3] as { result: Record<string, unknown> }).result.userPause,
    ).toBeUndefined();
    expect(mockBroadcastTaskSignalPersisted).toHaveBeenCalled();
  });

  it('returns false and never broadcasts when the CAS is blocked by anything OTHER than a supersede-able park', async () => {
    mockGetTaskById.mockResolvedValueOnce({
      status: 'running',
      result: {},
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskStatus.mockResolvedValueOnce(null);
    // Fresh read: a transient park (no userPause, no quiet-idle signal) — the park is honored.
    mockGetTaskById.mockResolvedValueOnce({
      status: 'needs_attention',
      result: { usageLimit: { message: 'limit', at: 'x' } },
      flowRunId: 'flow-run-1',
    });

    await expect(persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal })).resolves.toBe(
      false,
    );
    expect(mockBroadcastTaskSignalPersisted).not.toHaveBeenCalled();
  });

  // ── Late-wake supersede of a quiet-idle park ────────────────────────────
  //
  // A background wait longer than the idle ceiling parks the task (missing_completion_signal).
  // When the harness later wakes the agent and it signals for real, that signal is the truth:
  // it supersedes the park and re-opens the flow side, instead of being dropped by the CAS.

  const quietParkRow = (flowRunId: string | null) => ({
    status: 'needs_attention',
    result: {
      startMode: 'execute',
      agentSignal: { state: 'missing_completion_signal', summary: 'went quiet', at: 'x' },
    },
    flowRunId,
  });
  const doneSignal: TaskSignalPayload = {
    state: 'done',
    summary: 'Coverage passed; PR opened',
    at: '2026-01-01T01:00:00.000Z',
  };

  it('a late wake signal supersedes a settled quiet-idle park and re-opens the flow run', async () => {
    // The park settled long before the signal — the first read already sees it.
    mockGetTaskById.mockResolvedValue(quietParkRow('flow-run-1'));
    mockUpdateTaskStatus.mockResolvedValueOnce({ id: 'task-xyz', status: 'done' });

    await expect(
      persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal: doneSignal }),
    ).resolves.toBe(true);

    // Exactly one write: the supersede CAS on the park's status (no running/failed attempt).
    expect(mockUpdateTaskStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateTaskStatus.mock.calls[0]?.[3]).toMatchObject({
      expectStatuses: ['needs_attention'],
    });
    expect(mockUnparkQuietIdleFlowRun).toHaveBeenCalledWith(
      expect.anything(),
      'task-xyz',
      'flow-run-1',
    );
    expect(mockBroadcastTaskSignalPersisted).toHaveBeenCalled();
  });

  it('supersedes a quiet-idle park that CAS-won against this very signal (race branch)', async () => {
    mockGetTaskById.mockResolvedValueOnce({
      status: 'running',
      result: { startMode: 'execute' },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskStatus.mockResolvedValueOnce(null); // the park landed between read and write
    mockGetTaskById.mockResolvedValueOnce(quietParkRow('flow-run-1'));
    mockUpdateTaskStatus.mockResolvedValueOnce({ id: 'task-xyz', status: 'done' });

    await expect(
      persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal: doneSignal }),
    ).resolves.toBe(true);
    expect(mockUnparkQuietIdleFlowRun).toHaveBeenCalledTimes(1);
  });

  it('takes the ordinary write when the row became running between the two reads (a wake burst un-parked it)', async () => {
    mockGetTaskById.mockResolvedValueOnce(quietParkRow('flow-run-1'));
    const resumedResult = {
      startMode: 'execute',
      resumedBy: 'wake_burst',
      resumedAt: '2026-09-05T00:00:00.000Z',
    };
    mockGetTaskById.mockResolvedValueOnce({
      status: 'running',
      result: resumedResult,
      flowRunId: 'flow-run-1',
    });
    mockReplaceWakeResumedRow.mockResolvedValueOnce({ id: 'task-xyz', status: 'done' });

    await expect(
      persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal: doneSignal }),
    ).resolves.toBe(true);
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    // Same-row CAS: the write names the exact resumed row it read.
    expect(mockReplaceWakeResumedRow).toHaveBeenCalledWith(
      expect.anything(),
      'task-xyz',
      '2026-09-05T00:00:00.000Z',
      expect.objectContaining({ status: 'done' }),
    );
    expect(mockUnparkQuietIdleFlowRun).not.toHaveBeenCalled();
    expect(mockBroadcastTaskSignalPersisted).toHaveBeenCalledTimes(1);
  });

  it('supersedes a quiet-idle park on a plain (non-flow) task without touching flow state', async () => {
    mockGetTaskById.mockResolvedValue(quietParkRow(null));
    mockUpdateTaskStatus.mockResolvedValueOnce({ id: 'task-xyz', status: 'done' });

    await expect(
      persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal: doneSignal }),
    ).resolves.toBe(true);
    expect(mockUnparkQuietIdleFlowRun).not.toHaveBeenCalled();
  });

  it('drops the signal when the supersede CAS itself loses to a concurrent writer', async () => {
    mockGetTaskById.mockResolvedValue(quietParkRow('flow-run-1'));
    mockUpdateTaskStatus.mockResolvedValueOnce(null); // e.g. user resumed the park concurrently

    await expect(
      persistLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal: doneSignal }),
    ).resolves.toBe(false);
    expect(mockUnparkQuietIdleFlowRun).not.toHaveBeenCalled();
    expect(mockBroadcastTaskSignalPersisted).not.toHaveBeenCalled();
  });
});

describe('recordLinkedTaskSignal', () => {
  const signal: TaskSignalPayload = {
    state: 'done',
    summary: 'Work finished',
    at: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    mockGetTaskById.mockReset();
    mockUpdateTaskStatus.mockReset();
    mockUpdateTaskResult.mockReset();
    mockBroadcastTaskSignalPersisted.mockReset();
  });

  it('returns false when taskIdForExecution is missing', async () => {
    await expect(recordLinkedTaskSignal({ taskIdForExecution: undefined, signal })).resolves.toBe(
      false,
    );
    expect(mockGetTaskById).not.toHaveBeenCalled();
  });

  it('returns false when task status cannot accept task signals', async () => {
    mockGetTaskById.mockResolvedValue({ status: 'done', result: {} });
    await expect(recordLinkedTaskSignal({ taskIdForExecution: 't1', signal })).resolves.toBe(false);
    expect(mockUpdateTaskResult).not.toHaveBeenCalled();
  });

  it('records the agentSignal into result, keeps status running, never broadcasts terminal', async () => {
    mockGetTaskById.mockResolvedValue({
      status: 'running',
      result: { startMode: 'execute' },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskResult.mockResolvedValue({ id: 'task-xyz', status: 'running' });

    await expect(recordLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal })).resolves.toBe(
      true,
    );

    // Result-only write: no status arg, so startedAt/completedAt are untouched and the
    // task-completion-watcher does not see a terminal status until the post-stream flip.
    expect(mockUpdateTaskResult).toHaveBeenCalledWith(
      expect.anything(),
      'task-xyz',
      expect.objectContaining({ agentSignal: signal }),
      { expectStatuses: ['running', 'failed'] },
    );
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockBroadcastTaskSignalPersisted).not.toHaveBeenCalled();
  });

  it('returns false when the CAS write is blocked (a park landed between read and write)', async () => {
    mockGetTaskById.mockResolvedValue({ status: 'running', result: {}, flowRunId: 'flow-run-1' });
    mockUpdateTaskResult.mockResolvedValue(null);

    await expect(recordLinkedTaskSignal({ taskIdForExecution: 'task-xyz', signal })).resolves.toBe(
      false,
    );
  });

  it('preserves existing result fields and strips stale-failure meta when recording', async () => {
    // The flows task-completion-watcher maps the FINAL result → node output (startMode picks
    // plan vs execute; structured outputs feed downstream conditions). Recording the signal
    // mid-stream must merge, not clobber, or the eventual node output loses these.
    mockGetTaskById.mockResolvedValue({
      status: 'running',
      result: {
        startMode: 'plan',
        structuredOutputs: { reviewScore: 8 },
        verification: { shouldProceed: true },
        // Stale failure metadata from a prior lease blip — must NOT survive onto the live run.
        error: 'stale',
        failureCode: 'EXECUTION_LEASE_EXPIRED',
        staleExecution: true,
      },
      flowRunId: 'flow-run-1',
    });
    mockUpdateTaskResult.mockResolvedValue({ id: 'task-merge', status: 'running' });

    await expect(
      recordLinkedTaskSignal({ taskIdForExecution: 'task-merge', signal }),
    ).resolves.toBe(true);

    const writtenResult = mockUpdateTaskResult.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(writtenResult).toMatchObject({
      startMode: 'plan',
      structuredOutputs: { reviewScore: 8 },
      verification: { shouldProceed: true },
      agentSignal: signal,
    });
    expect(writtenResult.error).toBeUndefined();
    expect(writtenResult.failureCode).toBeUndefined();
    expect(writtenResult.staleExecution).toBeUndefined();
  });
});

describe('hasLatestTaskSignalFor', () => {
  beforeEach(() => mockGetLatestTaskSignal.mockReset());

  it('reports no signal when the context has none', async () => {
    mockGetLatestTaskSignal.mockReturnValue(undefined);
    await expect(hasLatestTaskSignalFor('exec-1')).resolves.toBe(false);
    await expect(hasLatestTaskSignalFor('exec-1', true)).resolves.toBe(false);
  });

  it('accepts a park as a turn ending when no plan was submitted this turn', async () => {
    // The default path, including every ordinary agent turn: awaiting_input IS a legitimate way to
    // end. Demanding a terminal here would nag an agent that correctly parked.
    mockGetLatestTaskSignal.mockReturnValue({ state: 'awaiting_input', summary: 'q', at: 'now' });
    await expect(hasLatestTaskSignalFor('exec-1')).resolves.toBe(true);
  });

  it('refuses a drafting-phase park as the implementation phase terminal', async () => {
    // The two-phase turn: an auto-approve node parks with awaiting_input while DRAFTING, then
    // submits its plan and implements in the SAME turn. The context keeps only the latest signal
    // and never clears it, so without this the stale park satisfies the mandatory terminal — the
    // run stops unchased and persists the obsolete question over finished work.
    mockGetLatestTaskSignal.mockReturnValue({ state: 'awaiting_input', summary: 'q', at: 'now' });
    await expect(hasLatestTaskSignalFor('exec-1', true)).resolves.toBe(false);
  });

  it('accepts a real terminal from the implementation phase', async () => {
    for (const state of ['done', 'partial', 'blocked', 'failed'] as const) {
      mockGetLatestTaskSignal.mockReturnValue({ state, summary: 's', at: 'now' });
      await expect(hasLatestTaskSignalFor('exec-1', true), state).resolves.toBe(true);
    }
  });
});
