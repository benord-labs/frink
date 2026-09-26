import log from 'electron-log';
import { scrubResumedResult } from '../db/repos/task-parking/resume-scrub';

/**
 * Revive a restart-interrupted flow task on a chat follow-up: probe eligibility, flip the
 * `cancelled` driving task → running (stripping the cancel/restart markers), then unpark its
 * run/node IN PLACE. NOT a re-dispatch — the executor's follow-up turn drives the work;
 * re-dispatching would double-run alongside it. The watcher advances on the agent's next `done`.
 * Extracted from resumeTaskOnFollowUpMessage to keep that closure under the complexity cap.
 *
 * The order is load-bearing twice over (see canReviveInterruptedFlowInPlace): a failed probe
 * returns with the task still `cancelled`, so the failure park's `running` CAS can never strand
 * the run paused-without-slot and re-dispatch recovery stays available; a passed probe flips the
 * task BEFORE the run/node go live, so the completion watcher's terminal-status query
 * structurally cannot re-select the task mid-revive (its advanced-set is not restart-durable).
 * The whole window runs under a flow-resource activity reservation — admission settlement defers
 * while activity is held, so the slot the probe saw cannot settle before the unpark's writes
 * land (the same check-then-act protection every other admission-consuming writer uses).
 *
 * Imports stay dynamic to keep the db/flows graph off the executor's static import chain.
 */
export async function reviveRestartInterruptedFlow(
  taskId: string,
  flowRunId: string,
  subChatId: string,
): Promise<void> {
  const { withFlowResourceCleanup } = await import('../flows/admission/activity');
  await withFlowResourceCleanup(flowRunId, () =>
    reviveWithinReservation(taskId, flowRunId, subChatId),
  );
}

async function reviveWithinReservation(
  taskId: string,
  flowRunId: string,
  subChatId: string,
): Promise<void> {
  const { canReviveInterruptedFlowInPlace } = await import('../flows/resume');
  if (!(await canReviveInterruptedFlowInPlace(flowRunId))) return;
  const { getDatabase } = await import('../db');
  const { getTaskById, updateTaskStatus } = await import('../db/repos/tasks');
  const db = getDatabase();
  const cancelledTask = await getTaskById(db, taskId);
  const previousResult =
    cancelledTask && typeof cancelledTask.result === 'object' && cancelledTask.result != null
      ? (cancelledTask.result as Record<string, unknown>)
      : {};
  // CAS on `cancelled`: a concurrent revive (double message) that already flipped this task wins,
  // and this one stops before touching the run — flipping blind here could otherwise pair a later
  // decline-revert with the winner's live run.
  const flipped = await updateTaskStatus(db, taskId, 'running', {
    result: {
      ...scrubResumedResult(previousResult),
      resumedBy: 'follow_up_message',
      resumedAt: new Date().toISOString(),
      previousStatus: cancelledTask?.status ?? 'cancelled',
    },
    expectStatuses: ['cancelled'],
  });
  if (!flipped) return;
  if (!(await unparkOrRevertFlip(db, taskId, flowRunId, subChatId, previousResult))) return;
  const { forgetAdvancedTask } = await import('../flows/task-completion-watcher');
  forgetAdvancedTask(taskId);
}

type Db = ReturnType<(typeof import('../db'))['getDatabase']>;

/**
 * Run the unpark for an already-flipped task; true means the revive landed and the watcher should
 * be re-armed. A clean `false` from the unpark is mutation-free (every decline path returns
 * before any write): the slot settled — or the node advanced — inside the flip→unpark gap, so
 * the flip is reverted (a `running` task over a still-`cancelled` run would swallow the agent's
 * eventual completion and satisfies no recovery precondition). A throw is disambiguated by the
 * run itself: still `cancelled` means the pre-write guards failed and nothing mutated — revert;
 * `running` means the unpark landed before throwing — continue best-effort, the turn drives.
 */
async function unparkOrRevertFlip(
  db: Db,
  taskId: string,
  flowRunId: string,
  subChatId: string,
  previousResult: Record<string, unknown>,
): Promise<boolean> {
  const { resumeInterruptedFlowInPlace } = await import('../flows/resume');
  try {
    if (await resumeInterruptedFlowInPlace(flowRunId)) return true;
    log.warn('[Socket Executor] in-place revive declined mid-flip; reverting task', {
      subChatId,
      flowRunId,
    });
    await revertFlip(db, taskId, previousResult);
    return false;
  } catch (err) {
    log.warn('[Socket Executor] resumeInterruptedFlowInPlace failed', {
      subChatId,
      flowRunId,
      error: err instanceof Error ? err.message : String(err),
    });
    const { captureFlowAdmissionException } = await import('../flows/admission/activity');
    captureFlowAdmissionException(err, 'revive-unpark');
    return revertFlipUnlessRunLive(db, taskId, flowRunId, subChatId, previousResult);
  }
}

/** Revert the CAS flip: only OUR `running` is undone — a task the turn already moved on stays. */
async function revertFlip(
  db: Db,
  taskId: string,
  previousResult: Record<string, unknown>,
): Promise<void> {
  const { updateTaskStatus } = await import('../db/repos/tasks');
  await updateTaskStatus(db, taskId, 'cancelled', {
    result: previousResult,
    expectStatuses: ['running'],
  });
}

async function revertFlipUnlessRunLive(
  db: Db,
  taskId: string,
  flowRunId: string,
  subChatId: string,
  previousResult: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { getFlowRun } = await import('../db/repos/flow-runs');
    if ((await getFlowRun(db, flowRunId))?.status === 'running') return true;
    await revertFlip(db, taskId, previousResult);
  } catch (revertErr) {
    // A failed revert is the one branch that can leave a running task over a terminal run with
    // nothing driving recovery — the exact stranded shape this module exists to prevent.
    log.error('[Socket Executor] revive revert failed; task may need a manual Retry', {
      subChatId,
      flowRunId,
      error: revertErr instanceof Error ? revertErr.message : String(revertErr),
    });
    const { captureFlowAdmissionException } = await import('../flows/admission/activity');
    captureFlowAdmissionException(revertErr, 'revive-revert');
  }
  return false;
}
