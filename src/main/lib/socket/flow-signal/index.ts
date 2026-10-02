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
  clearDispatchStartedMarker,
  nextDispatchStamp,
  setDispatchStartedMarker,
  undeliveredDispatchSince,
} from '../../db/repos/task-parking/dispatch-marker';
import {
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForSubChat,
  getTaskById,
  isTerminalFinalTaskStatus,
} from '../../db/repos/tasks';
import { captureMainException, captureMainMessage } from '../../sentry/init';
import {
  type DispatchProvenance,
  deliveringTaskOf,
  markDeliveringTurn,
  unmarkDeliveringTurn,
} from '../../task-executor/dispatch-registry';

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
  /** sc-2775: set (with `taskSignalDisarmed`) when a turn the step's dispatch did not send arrives
   * while that step's prompt is undelivered — it must not complete the step. */
  undeliveredDispatchTaskId: string | null;
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
 * task outlives its run being cancelled, which left the stop hook armed after a Stop. Also the
 * `frink_task_signal` handler's call-time check, so the tool refuses exactly what arming disarms.
 */
export async function isSignalTargetDead(task: SignalTaskRow): Promise<boolean> {
  if (!task) return true;
  if (isTerminalFinalTaskStatus(task.status)) return true;
  return isFlowRunSignalDead(getDatabase(), task.flowRunId);
}

/** Only an UNDELIVERED dispatch bars other turns: once the step's own turn ran, a reply resuming a
 * parked step signals it as before. */
export function isTurnForeignToUndeliveredDispatch(
  task: SignalTaskRow,
  dispatch: DispatchProvenance | undefined,
): boolean {
  if (!task || task.status !== 'running') return false;
  const result = task.result as Record<string, unknown> | null;
  // An earlier attempt's turn (same task id, older generation) is as foreign as an operator's.
  if (dispatch?.taskId === task.id && dispatch.dispatchedAt === result?.dispatchedAt) return false;
  return undeliveredDispatchSince(task.result) !== null;
}

/** Reuses the arming prefetch when it holds the target row (one read per follow-up turn); another
 * target (the flow-driving task) is read fresh. */
export async function getTaskRowForResume(
  db: ReturnType<typeof getDatabase>,
  targetTaskId: string,
  prefetched: SignalTaskRow,
): Promise<SignalTaskRow> {
  if (prefetched?.id === targetTaskId) return prefetched;
  return getTaskById(db, targetTaskId);
}

export async function resolveFlowSignalArming(
  subChatId: string | undefined,
  taskIdForExecution: string | null,
  /** The dispatch attempt this turn delivers; undefined for user-typed and mobile sends. */
  dispatch?: DispatchProvenance,
): Promise<FlowSignalArming> {
  const armed: FlowSignalArming = {
    isFlowDrivenExecution: false,
    flowPlanAutoApprove: false,
    taskSignalDisarmed: false,
    prefetchedSignalTask: null,
    provenanceLookupError: null,
    restartInterruptedFlowRunId: null,
    effectiveSignalTaskId: taskIdForExecution,
    undeliveredDispatchTaskId: null,
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
      if (
        !armed.taskSignalDisarmed &&
        isTurnForeignToUndeliveredDispatch(armed.prefetchedSignalTask, dispatch)
      ) {
        armed.taskSignalDisarmed = true;
        armed.undeliveredDispatchTaskId = armed.effectiveSignalTaskId;
      }
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

/** After admission: a dispatched turn stamps its dispatch started — or, when that attempt has been
 * superseded (or the stamp fails), is disarmed like a foreign turn. Never throws. */
export async function recordDispatchTurnStart(
  armed: Pick<FlowSignalArming, 'undeliveredDispatchTaskId' | 'taskSignalDisarmed'>,
  dispatch: DispatchProvenance | undefined,
  subChatId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (dispatch && !(await stampDispatchStarted(dispatch, signal))) {
    armed.taskSignalDisarmed = true;
    armed.undeliveredDispatchTaskId = dispatch.taskId;
  }
  if (!armed.undeliveredDispatchTaskId) return;
  log.warn('[Socket Executor] turn not armed: its flow step has not received its prompt yet', {
    subChatId,
    taskId: armed.undeliveredDispatchTaskId,
  });
  captureMainMessage('Turn ran while its flow step prompt was undelivered', 'warning', {
    surface: 'flow-signal-foreign-turn',
  });
}

/** A turn that replaces the step's own dispatched turn interrupts that delivery — it was armed from
 * the stamp the replaced turn wrote, so it must be disarmed before that turn is aborted. */
export function abortReplacedTurn(
  armed: Pick<FlowSignalArming, 'undeliveredDispatchTaskId' | 'taskSignalDisarmed'>,
  replaced: AbortController,
  /** The replacing turn's own dispatch: a resend of the same step takes over the delivery instead. */
  dispatch: DispatchProvenance | undefined,
): void {
  const taskId = deliveringTaskOf(replaced.signal);
  // A turn with its own proven dispatch delivers that one; only an unproven turn is disarmed.
  if (taskId && !dispatch) {
    armed.taskSignalDisarmed = true;
    armed.undeliveredDispatchTaskId = taskId;
  }
  replaced.abort();
}

async function stampDispatchStarted(
  dispatch: DispatchProvenance,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const at = nextDispatchStamp();
  // Registered BEFORE the write, so a concurrent re-claim sees this delivery (flowDispatchStamps).
  if (signal) markDeliveringTurn(signal, dispatch.taskId);
  if (!(await tryStampDispatchStarted(dispatch, at))) {
    if (signal) unmarkDeliveringTurn(signal);
    return false;
  }
  // An aborted dispatched turn (replaced, paused, stopped) has not delivered the step: undo exactly
  // this turn's stamp, never one a later turn of the same attempt has written since.
  const undo = () =>
    void clearDispatchStartedMarker(
      getDatabase(),
      dispatch.taskId,
      dispatch.dispatchedAt,
      at,
    ).catch(() => null);
  if (signal?.aborted) undo();
  else signal?.addEventListener('abort', undo, { once: true });
  return !signal?.aborted;
}

async function tryStampDispatchStarted({ taskId, dispatchedAt }: DispatchProvenance, at: string) {
  try {
    return (await setDispatchStartedMarker(getDatabase(), taskId, dispatchedAt, at)) !== null;
  } catch (err) {
    log.warn('[Socket Executor] dispatch-started stamp failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureMainException(err, { surface: 'flow-dispatch-started-stamp' });
    return false;
  }
}
