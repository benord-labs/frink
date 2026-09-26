import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTaskById = vi.fn();
const updateTaskStatus = vi.fn();
const resumeInterruptedFlowInPlace = vi.fn();
const canReviveInterruptedFlowInPlace = vi.fn();

vi.mock('../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../db/repos/tasks', () => ({
  getTaskById: (...args: unknown[]) => getTaskById(...args),
  updateTaskStatus: (...args: unknown[]) => updateTaskStatus(...args),
}));
vi.mock('../flows/resume', () => ({
  resumeInterruptedFlowInPlace: (...args: unknown[]) => resumeInterruptedFlowInPlace(...args),
  canReviveInterruptedFlowInPlace: (...args: unknown[]) => canReviveInterruptedFlowInPlace(...args),
}));
const forgetAdvancedTask = vi.fn();
vi.mock('../flows/task-completion-watcher', () => ({
  forgetAdvancedTask: (...args: unknown[]) => forgetAdvancedTask(...args),
}));
const getFlowRun = vi.fn();
vi.mock('../db/repos/flow-runs', () => ({
  getFlowRun: (...args: unknown[]) => getFlowRun(...args),
}));

import { reviveRestartInterruptedFlow } from './revive-interrupted-flow';

/** The result a cancel MERGES onto a task the restart interrupted, markers of the ended attempt and all. */
function cancelledTaskResult(): Record<string, unknown> {
  return {
    cancelled: true,
    error: 'Interrupted by app restart',
    subChatId: 'sub-1',
    userPause: { at: '2026-07-14T00:00:00Z' },
    apiError: { status: 500 },
    agentSignal: { state: 'awaiting_input', summary: 'stale ask' },
  };
}

function resumePayload(): Record<string, unknown> {
  const call = updateTaskStatus.mock.calls[0]?.[3] as { result?: Record<string, unknown> };
  return call.result ?? {};
}

describe('reviveRestartInterruptedFlow', () => {
  beforeEach(() => {
    getTaskById.mockReset();
    updateTaskStatus.mockReset().mockResolvedValue({ id: 'task-1', status: 'running' });
    forgetAdvancedTask.mockReset();
    getFlowRun.mockReset().mockResolvedValue({ id: 'fr-1', status: 'running' });
    canReviveInterruptedFlowInPlace.mockReset().mockResolvedValue(true);
    resumeInterruptedFlowInPlace.mockReset().mockResolvedValue(true);
  });

  // The probe declines when the run is not revivable (no marker, or no active admission slot — a
  // revive continues the run WITHOUT re-admitting, so a slotless wake would be rejected at the
  // provider preflight and the failure park would rewrite the run `paused` with no slot,
  // unrecoverable). Leaving the task `cancelled` keeps the park's `running` CAS unmatchable and
  // the run on the re-dispatch path, which re-admits.
  it('leaves the task cancelled and unparks nothing when the probe declines', async () => {
    canReviveInterruptedFlowInPlace.mockResolvedValue(false);

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(resumeInterruptedFlowInPlace).not.toHaveBeenCalled();
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });

  it('flips the cancelled driving task back to running and records what revived it', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(updateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'running',
      expect.objectContaining({
        result: expect.objectContaining({
          resumedBy: 'follow_up_message',
          previousStatus: 'cancelled',
        }),
      }),
    );
  });

  // Every marker describes the attempt that ENDED. A survivor misclassifies the NEXT park — a stale
  // userPause renders the paused bar instead of the question card, a stale apiError reads as a
  // transient retry. The sub-chat linkage is not a marker: the resume lookup needs it.
  it('clears the ended attempt’s markers but keeps the sub-chat linkage', async () => {
    getTaskById.mockResolvedValueOnce({
      id: 'task-1',
      status: 'cancelled',
      result: cancelledTaskResult(),
    });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    const result = resumePayload();
    expect(result.cancelled).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.userPause).toBeUndefined();
    expect(result.apiError).toBeUndefined();
    expect(result.agentSignal).toBeUndefined();
    expect(result.subChatId).toBe('sub-1');
  });

  // NOT a re-dispatch: the follow-up turn drives the work, so re-dispatching would double-run.
  it('unparks the run in place, keyed to the run alone', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(resumeInterruptedFlowInPlace).toHaveBeenCalledWith('fr-1');
  });

  // Structural race guard: the task must read `running` BEFORE the run/node go live, so the
  // completion watcher's terminal-status query cannot re-select it mid-revive and re-advance the
  // stale cancelled output (its in-memory advanced-set does not survive a second restart). The
  // forget re-arms the watcher for the agent's next real `done`, after the flip.
  it('flips the task before unparking, then forgets it for the watcher', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(forgetAdvancedTask).toHaveBeenCalledWith('task-1');
    const flipOrder = updateTaskStatus.mock.invocationCallOrder[0];
    const unparkOrder = resumeInterruptedFlowInPlace.mock.invocationCallOrder[0];
    const forgetOrder = forgetAdvancedTask.mock.invocationCallOrder[0];
    expect(unparkOrder).toBeGreaterThan(flipOrder);
    expect(forgetOrder).toBeGreaterThan(flipOrder);
  });

  it('treats a missing or non-object previous result as empty rather than throwing', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled', result: null });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(resumePayload().resumedBy).toBe('follow_up_message');
  });

  it('falls back to `cancelled` when the task row has vanished', async () => {
    getTaskById.mockResolvedValueOnce(undefined);

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(resumePayload().previousStatus).toBe('cancelled');
  });

  // TOCTOU inside the revive: the probe passed, but the slot settled during the flip→unpark gap
  // and the unpark declined (mutation-free). A `running` task over a still-`cancelled` run would
  // swallow the agent's completion and satisfy no recovery precondition — the flip must be
  // reverted to the exact pre-revive shape so Re-run/Retry stay available.
  it('reverts the flip when the unpark declines after the task went running', async () => {
    getTaskById.mockResolvedValueOnce({
      id: 'task-1',
      status: 'cancelled',
      result: cancelledTaskResult(),
    });
    resumeInterruptedFlowInPlace.mockResolvedValue(false);

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(updateTaskStatus).toHaveBeenLastCalledWith(expect.anything(), 'task-1', 'cancelled', {
      result: cancelledTaskResult(),
      expectStatuses: ['running'],
    });
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });

  // Check-then-act protection: admission settlement defers while flow-resource activity is held,
  // so the slot the probe saw cannot settle before the unpark's writes land. The reservation must
  // span the ENTIRE window (probe through unpark) and release afterwards.
  it('holds a flow-resource reservation across the whole revive window', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });
    const { hasFlowResourceActivity } = await import('../flows/admission/activity');
    canReviveInterruptedFlowInPlace.mockImplementation(async () => {
      expect(hasFlowResourceActivity('fr-1')).toBe(true);
      return true;
    });
    resumeInterruptedFlowInPlace.mockImplementation(async () => {
      expect(hasFlowResourceActivity('fr-1')).toBe(true);
      return true;
    });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(hasFlowResourceActivity('fr-1')).toBe(false);
  });

  // Double message: a concurrent revive already flipped the task, so this one's CAS matches
  // nothing. It must stop entirely — proceeding could pair its decline-revert with the winner's
  // live run, re-exposing a terminal task to the watcher against a running node.
  it('stops without unparking when the running flip loses the CAS', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });
    updateTaskStatus.mockResolvedValue(null);

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(resumeInterruptedFlowInPlace).not.toHaveBeenCalled();
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });

  // A throw AFTER the unpark landed (run reads `running`) is best-effort: the task stays flipped
  // and the follow-up turn drives the work; aborting here would strand the state just set.
  it('swallows a post-unpark failure so the follow-up turn still runs', async () => {
    getTaskById.mockResolvedValueOnce({ id: 'task-1', status: 'cancelled' });
    resumeInterruptedFlowInPlace.mockRejectedValueOnce(new Error('emit failed'));
    getFlowRun.mockResolvedValue({ id: 'fr-1', status: 'running' });

    await expect(reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1')).resolves.toBeUndefined();
    expect(updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(forgetAdvancedTask).toHaveBeenCalledWith('task-1');
  });

  // A throw BEFORE any unpark write (run still `cancelled` — e.g. the unpark's own guard reads
  // failed) must revert the flip like a clean decline: a `running` task over a cancelled node is
  // unreachable by advance's node CAS, so the agent's done would be silently dropped forever.
  it('reverts the flip when the unpark throws with the run still cancelled', async () => {
    getTaskById.mockResolvedValueOnce({
      id: 'task-1',
      status: 'cancelled',
      result: cancelledTaskResult(),
    });
    resumeInterruptedFlowInPlace.mockRejectedValueOnce(new Error('admission store unavailable'));
    getFlowRun.mockResolvedValue({ id: 'fr-1', status: 'cancelled' });

    await reviveRestartInterruptedFlow('task-1', 'fr-1', 'sub-1');

    expect(updateTaskStatus).toHaveBeenLastCalledWith(expect.anything(), 'task-1', 'cancelled', {
      result: cancelledTaskResult(),
      expectStatuses: ['running'],
    });
    expect(forgetAdvancedTask).not.toHaveBeenCalled();
  });
});
