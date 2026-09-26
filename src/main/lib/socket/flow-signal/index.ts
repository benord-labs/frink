/**
 * Resolves, for one turn, whether a flow task drives this sub-chat and which task the agent's
 * `frink_task_signal` should target — the turn-setup half of the task-signal apparatus, kept out of
 * `handleRemoteExecute` so it is testable and readable on its own.
 */

import log from 'electron-log';
// Static, not `await import`: the db layer has no edge back into socket/, so laziness buys nothing
// here, and two turns arming at once can resolve the same lazy specifier to different module
// instances — which loses a test's module mock and fabricates a provenance fault that aborts the
// turn. `../../flows/resume` below stays lazy: it reaches flows/advance, which does cycle back here.
import { getDatabase } from '../../db';
import { isFlowRunSignalDead } from '../../db/repos/flow-runs';
import {
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForSubChat,
  getTaskById,
  isTerminalFinalTaskStatus,
} from '../../db/repos/tasks';
import { captureMainException } from '../../sentry/init';

type SignalTaskRow = Awaited<ReturnType<typeof getTaskById>>;

export type FlowSignalArming = {
  /** A flow task is live on this sub-chat — suppresses the in-chat plan-card Approve. */
  isFlowDrivenExecution: boolean;
  /** The driving node is a plan node with skipReview: emit the card `approved` and auto-advance. */
  flowPlanAutoApprove: boolean;
  /** Nothing left to signal — drop the lifecycle prompt, stop hook and `frink_task_signal` tool. */
  taskSignalDisarmed: boolean;
  /** The task row read here, reused by the follow-up resume so a turn does a single read. */
  prefetchedSignalTask: SignalTaskRow;
  /** A durable provenance read failed, so admission must not classify this turn as ordinary. */
  provenanceLookupError: { cause: unknown } | null;
  /** Set when the newest flow task is a `cancelled` row whose run a restart interrupted. */
  restartInterruptedFlowRunId: string | null;
  /** The task an agent signal lands on: the driving flow task, else the chat's pinned task. */
  effectiveSignalTaskId: string | null;
};

/** Unknown provenance stays execution-fail-open, but its signal write must not fail silently. */
export function requiresStrictSignalFinalization(armed: FlowSignalArming): boolean {
  return (
    armed.isFlowDrivenExecution ||
    armed.restartInterruptedFlowRunId !== null ||
    armed.provenanceLookupError !== null
  );
}

/** Complete session disposition even when required Flow-signal persistence fails. */
export async function finalizeFlowSignalBeforeSessionDisposition(
  finalization: Promise<void>,
  dispose?: () => Promise<void>,
): Promise<{ cause: unknown } | null> {
  const [outcome] = await Promise.allSettled([finalization]);
  const persistenceFailure = outcome.status === 'rejected' ? { cause: outcome.reason } : null;
  try {
    await dispose?.();
  } catch (dispositionError) {
    if (persistenceFailure) {
      throw new AggregateError(
        [persistenceFailure.cause, dispositionError],
        'Signal finalization and session disposition both failed',
      );
    }
    throw dispositionError;
  }
  return persistenceFailure;
}

/**
 * Both flags derive from the flow task driving THIS sub-chat (keyed on `result.subChatId`), NOT the
 * chat's pinned `taskId`: a flow chat's `taskId` stays linked to its FIRST task (often an `execute`
 * node) while later nodes drive the same sub-chat, so the pinned task reports the wrong `startMode`
 * and a later node's signal would land on the first, now-terminal, task and be dropped.
 *
 * Fails OPEN: a DB read fault degrades to not-flow-driven (worst case, the in-chat Approve is
 * re-shown) rather than taking the turn down.
 */
/**
 * Nothing can consume a signal aimed at this task: the row is gone, its status is terminal-final, or
 * its RUN is terminal. The run check is the one status alone misses — a parked (`needs_attention`)
 * task outlives its run being cancelled, which left the stop hook armed after a Stop.
 */
async function isSignalTargetDead(task: SignalTaskRow): Promise<boolean> {
  if (!task) return true;
  if (isTerminalFinalTaskStatus(task.status)) return true;
  return isFlowRunSignalDead(getDatabase(), task.flowRunId);
}

export async function resolveFlowSignalArming(
  subChatId: string | undefined,
  taskIdForExecution: string | null,
): Promise<FlowSignalArming> {
  const armed: FlowSignalArming = {
    isFlowDrivenExecution: false,
    flowPlanAutoApprove: false,
    taskSignalDisarmed: false,
    prefetchedSignalTask: null,
    provenanceLookupError: null,
    restartInterruptedFlowRunId: null,
    effectiveSignalTaskId: taskIdForExecution,
  };
  if (!subChatId) return armed;

  try {
    const driveInfo = await getFlowDriveInfoForSubChat(getDatabase(), subChatId);
    armed.isFlowDrivenExecution = driveInfo.active;
    armed.flowPlanAutoApprove = driveInfo.autoApprovePlan;
    armed.effectiveSignalTaskId =
      driveInfo.active && driveInfo.taskId ? driveInfo.taskId : taskIdForExecution;

    const revived = driveInfo.active ? null : await restartInterruptedTarget(subChatId);
    if (revived) {
      // Retarget the signal at the revived task and stay ARMED — its next `done` advances the flow.
      armed.effectiveSignalTaskId = revived.id;
      armed.restartInterruptedFlowRunId = revived.flowRunId;
      return armed;
    }

    if (armed.effectiveSignalTaskId) {
      armed.prefetchedSignalTask = await getTaskById(getDatabase(), armed.effectiveSignalTaskId);
      armed.taskSignalDisarmed = await isSignalTargetDead(armed.prefetchedSignalTask);
    }
  } catch (err) {
    // Fail OPEN, but never silently: this swallows a DB read fault, and the degraded turn looks
    // normal to the user (the in-chat Approve reappears and the signal apparatus stays armed on a
    // dead chat), so a log line alone leaves the fault invisible.
    armed.isFlowDrivenExecution = false;
    armed.flowPlanAutoApprove = false;
    // Wrap the caught value: JavaScript permits `throw null`, so null itself cannot be the
    // no-failure sentinel at the admission boundary.
    armed.provenanceLookupError = { cause: err };
    log.warn('[Socket Executor] flow-driven check failed; plan card Approve not suppressed', {
      subChatId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureMainException(err, { surface: 'flow-signal-arming' });
  }
  return armed;
}

/**
 * The `cancelled` driving task a chat follow-up should REVIVE in place rather than treat as a dead
 * chat: its run was interrupted by a restart/reload, so it carries the marker. `null` for a
 * deliberate user cancel (no marker) — status alone never separates the two.
 */
async function restartInterruptedTarget(
  subChatId: string,
): Promise<{ id: string; flowRunId: string } | null> {
  const latest = await getLatestFlowTaskForSubChat(getDatabase(), subChatId);
  if (latest?.status !== 'cancelled' || !latest.flowRunId) return null;
  const { isRunRestartInterrupted } = await import('../../flows/resume');
  if (!(await isRunRestartInterrupted(latest.flowRunId))) return null;
  return { id: latest.id, flowRunId: latest.flowRunId };
}
