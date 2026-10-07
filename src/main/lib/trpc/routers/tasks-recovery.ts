/** Recovering stopped tasks: the one Continue-or-Retry action per row, and Continue all for the
 * runs a restart interrupted. */

import { TRPCError } from '@trpc/server';
import {
  type BulkRecoverResult,
  type RecoverOutcome,
  type RecoveryKind,
  recoverInterruptedInputSchema,
} from '../../../../shared/types/flow-run/resume';
import { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import {
  getTaskById,
  listTasksWithProjectPaginated,
  retryTaskDetailed,
} from '../../db/repos/tasks';
import type { FlowRun, Task } from '../../db/schema';
import type { TerminalResumeAdmission } from '../../flows/admission/terminal-resume/dispatcher';
import type { InterruptedRecoveryItem } from '../../flows/rerun/recover-interrupted';
import { publicProcedure } from '../index';
import { throwCarryOnReason, throwTaskMutationReason } from './task-refusals';
import {
  assertRecoveryStep,
  recoverTaskInputSchema,
  withStoppedTaskRecoveries,
} from './tasks-subchat';

type Db = ReturnType<typeof getDatabase>;

/** More than any restart leaves behind; the bulk action's dialog lists every one of them. */
const INTERRUPTED_RUNS_LIMIT = 500;

/** A resume already waits for the run: a queued ticket, or a continuation staged behind its slot. */
async function hasQueuedResume(flowRunId: string): Promise<boolean> {
  const { probeFlowAdmission } = await import('../../flows/admission/runtime');
  const { hasStagedContinuation } =
    await import('../../flows/admission/terminal-resume/continuation');
  return hasStagedContinuation(flowRunId) || (await probeFlowAdmission(flowRunId)).queuedResume;
}

/** One row per run a restart interrupted, each stamped with its recovery, oldest first. A run
 * whose resume is already queued (startup queues some) has nothing left to click. */
export async function listInterruptedRuns(
  db: Db,
  isResumeQueued: (flowRunId: string) => Promise<boolean> = hasQueuedResume,
) {
  const page = await listTasksWithProjectPaginated(db, {
    status: 'interrupted',
    collapseByFlow: true,
    limit: INTERRUPTED_RUNS_LIMIT,
  });
  const rows = await withStoppedTaskRecoveries(db, page.items);
  const queued = new Set<string>();
  for (const { flowRunId } of rows) {
    if (flowRunId && (await isResumeQueued(flowRunId))) queued.add(flowRunId);
  }
  return rows.reverse().flatMap((row) =>
    row.recoveryKind && row.flowRunId && !queued.has(row.flowRunId)
      ? [
          {
            taskId: row.id,
            flowRunId: row.flowRunId,
            projectId: row.projectId,
            projectName: row.projectName,
            description: row.description,
            recoveryKind: row.recoveryKind,
            confirmSideEffects: row.confirmSideEffects,
            recoveryNodeRunId: row.recoveryNodeRunId,
          },
        ]
      : [],
  );
}

/** Continues the stopped session; carryOnFlowTask re-checks the kind itself (`no-session`). */
async function continueTask(db: Db, taskId: string): Promise<void> {
  const { carryOnFlowTask } = await import('../../flows/rerun');
  const res = await carryOnFlowTask(db, taskId);
  if (res.ok) return;
  if (res.reason !== 'no-session') throwCarryOnReason(res.reason);
  const { recoveryChangedError } = await import('../../flows/rerun/recovery-kind');
  throw recoveryChangedError();
}

/** Restarts a non-Flow task fresh from its instructions, re-checking Retry in the same write. */
async function restartTask(db: Db, task: Task): Promise<void> {
  const { recoveryChangedError, withRecoveryKind } =
    await import('../../flows/rerun/recovery-kind');
  const outcome = withRecoveryKind(db, task.id, 'retry', () =>
    retryTaskDetailed(db, task.id, 'restart'),
  );
  if (!outcome) throw recoveryChangedError();
  if (outcome.task) return;
  throwTaskMutationReason(outcome.reason, {
    notFound: 'Task not found',
    invalidState: 'Only failed or attention-parked tasks can be retried',
    fallback: 'Could not retry task',
  });
}

/** A Flow task's run-level recoveries; each re-checks `kind`. Injectable, so tests pass fakes. */
export type FlowRunRecoveries = {
  retryPausedStep: (runId: string, nodeRunId: string, kind: RecoveryKind) => Promise<void>;
  readmitRun: (db: Db, run: FlowRun, kind: RecoveryKind) => Promise<TerminalResumeAdmission>;
};

const flowRunRecoveries: FlowRunRecoveries = {
  retryPausedStep: async (runId, nodeRunId, kind) => {
    const { resumeFlowRun } = await import('../../flows/resume');
    await resumeFlowRun(runId, 'retry', nodeRunId, undefined, kind);
  },
  readmitRun: async (db, run, kind) => {
    const { retryRunFromLastNode } = await import('./flows/run-actions');
    return retryRunFromLastNode(db, run, kind);
  },
};

/** Re-dispatches the step of a paused run, else re-admits a settled run from its last step. */
async function recoverFlowTask(
  db: Db,
  task: Task,
  run: FlowRun | null,
  kind: RecoveryKind,
  flowRuns: FlowRunRecoveries,
): Promise<RecoverOutcome> {
  // sourceId is the node_run the task was minted for.
  if (run?.status === 'paused' && task.sourceId) {
    await flowRuns.retryPausedStep(run.id, task.sourceId, kind);
    return 'resumed';
  }
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  return admissionOutcome(await flowRuns.readmitRun(db, run, kind));
}

/** A re-admitted run's outcome: merged into a live resume, waiting behind the cap, or running. */
function admissionOutcome({ state, created }: TerminalResumeAdmission): RecoverOutcome {
  if (!created) return 'already-queued';
  return state === 'queued' ? 'queued' : 'resumed';
}

/**
 * Routes a recovery: continue the session or restart fresh (non-Flow task); continue or
 * re-dispatch the step (paused Flow run); re-admit from the last unfinished step (settled run).
 */
export async function recoverTask(
  db: Db,
  taskId: string,
  kind: RecoveryKind,
  flowRuns: FlowRunRecoveries = flowRunRecoveries,
): Promise<RecoverOutcome> {
  const task = await getTaskById(db, taskId);
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  const run = task.flowRunId ? await getFlowRun(db, task.flowRunId) : null;
  if (kind === 'continue' && (!task.flowRunId || run?.status === 'paused')) {
    await continueTask(db, taskId);
    return 'resumed';
  }
  if (task.flowRunId) return recoverFlowTask(db, task, run, kind, flowRuns);
  await restartTask(db, task);
  return 'resumed';
}

export const taskRecoveryProcedures = {
  /**
   * One recovery action of a stopped task, re-resolved here so a stale label never does the other
   * thing: `continue` resumes the answering session, `retry` re-runs from instructions.
   */
  recover: publicProcedure
    .input(recoverTaskInputSchema)
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      await assertRecoveryStep(getDatabase(), input.taskId, input.recoveryNodeRunId);
      await recoverTask(getDatabase(), input.taskId, input.kind);
      return { ok: true };
    }),

  /** Every restart-interrupted run, for the Work Queue's Continue all. */
  interruptedRuns: publicProcedure.query(async () => listInterruptedRuns(getDatabase())),

  /**
   * Recovers each confirmed interrupted run as its own button would, in order; a started non-agent
   * step is reported back for its own confirm, never re-run here.
   */
  recoverInterrupted: publicProcedure
    .input(recoverInterruptedInputSchema)
    .mutation(async ({ input }): Promise<BulkRecoverResult[]> => {
      return recoverInterruptedTasks(getDatabase(), input.items, {
        flowRuns: flowRunRecoveries,
        hasQueuedResume,
      });
    }),
};

/** Continue all through the row recovery; `deps` injectable, so tests pass fakes. */
export async function recoverInterruptedTasks(
  db: Db,
  items: readonly InterruptedRecoveryItem[],
  deps: { flowRuns: FlowRunRecoveries; hasQueuedResume: (flowRunId: string) => Promise<boolean> },
): Promise<BulkRecoverResult[]> {
  const { recoverInterruptedRuns } = await import('../../flows/rerun/recover-interrupted');
  return recoverInterruptedRuns(db, items, {
    hasQueuedResume: deps.hasQueuedResume,
    recoverOne: async (taskId, kind, recoveryNodeRunId) => {
      await assertRecoveryStep(db, taskId, recoveryNodeRunId);
      return recoverTask(db, taskId, kind, deps.flowRuns);
    },
  });
}
