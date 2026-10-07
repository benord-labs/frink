/**
 * Tasks Router (LOCAL SQLite, post-migration).
 *
 * All procedures back the local Drizzle repo at src/main/lib/db/repos/tasks.ts.
 * Renderer call sites consume DbTask camelCase rows — repo returns Drizzle
 * camelCase directly so no adapter layer is needed.
 *
 * UUID validators relaxed to non-empty string for cuid2 IDs.
 */

import { hostname } from 'node:os';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { RecoveryKind } from '../../../../shared/types/flow-run/resume';
import type { TaskChatReadyData } from '../../../../shared/types/task-chat-ready';
import { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { getWorkQueueOverviewCounts } from '../../db/repos/task-queries/work-queue-overview-counts';
import {
  cancelAllPendingTasks,
  completeAllDoneTasks,
  completeDoneTasksForFlowRun,
  createTask,
  type DeleteTaskResult,
  deleteTaskDetailed,
  deleteTasksMatchingStatuses,
  getPendingTaskIds,
  getTaskById,
  getTaskCounts,
  listTasksWithProjectPaginated,
  reassignTaskDetailed,
  retryTaskDetailed,
  startExecutionFromReviewDetailed,
  updateTaskStatus,
} from '../../db/repos/tasks';
import type { FlowRun, Task } from '../../db/schema';
import {
  isDispatchPending,
  listUndeliveredDispatches,
} from '../../task-executor/dispatch-registry';
import { getTaskPoller } from '../../task-poller';
import { cancelWorkQueueTask } from '../../tasks/cancel-work-queue-task';
import { publicProcedure, router } from '../index';
import { PhoneSafeRefusal, throwCarryOnReason, throwTaskMutationReason } from './task-refusals';
import {
  assertRecoveryStep,
  getTaskWithRunOutcome,
  recoverTaskInputSchema,
  type TaskWithRunOutcome,
  taskSubChatProcedures,
  withStoppedTaskRecoveries,
} from './tasks-subchat';

type Db = ReturnType<typeof getDatabase>;

const taskSourceSchema = z.string().min(1).max(50);
const workQueueSectionSchema = z.enum(['attention', 'inbox', 'running']);
/** PERSISTED statuses — the only values a mutation may write to tasks.status. */
const taskStatusSchema = z.enum([
  'pending',
  'running',
  'plan_ready',
  'needs_attention',
  'done',
  'completed',
  'failed',
  'cancelled',
]);
/**
 * FILTERABLE statuses — the persisted set plus the statuses the queue only DERIVES
 * (repos/tasks.ts effectiveStatusExpr). Kept separate from `taskStatusSchema` on purpose: the work
 * queue must be able to ask for `interrupted`, but no mutation may ever write it as a real status.
 */
const taskFilterStatusSchema = z.enum([...taskStatusSchema.options, 'interrupted']);
const bulkDeleteTaskStatusSchema = z.enum([
  'pending',
  'plan_ready',
  'needs_attention',
  'done',
  'completed',
  'failed',
  'cancelled',
]);
const deleteMatchingInputSchema = z.object({
  statuses: z.array(bulkDeleteTaskStatusSchema).min(1),
});
const paginatedCursorSchema = z.object({ createdAt: z.string(), id: z.string() });

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
  readmitRun: (db: Db, run: FlowRun, kind: RecoveryKind) => Promise<void>;
};

const flowRunRecoveries: FlowRunRecoveries = {
  retryPausedStep: async (runId, nodeRunId, kind) => {
    const { resumeFlowRun } = await import('../../flows/resume');
    await resumeFlowRun(runId, 'retry', nodeRunId, undefined, kind);
  },
  readmitRun: async (db, run, kind) => {
    const { retryRunFromLastNode } = await import('./flows/run-actions');
    await retryRunFromLastNode(db, run, kind);
  },
};

/** Re-dispatches the step of a paused run, else re-admits a settled run from its last step. */
async function recoverFlowTask(
  db: Db,
  task: Task,
  run: FlowRun | null,
  kind: RecoveryKind,
  flowRuns: FlowRunRecoveries,
): Promise<void> {
  // sourceId is the node_run the task was minted for.
  if (run?.status === 'paused' && task.sourceId) {
    return flowRuns.retryPausedStep(run.id, task.sourceId, kind);
  }
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  return flowRuns.readmitRun(db, run, kind);
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
): Promise<void> {
  const task = await getTaskById(db, taskId);
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  const run = task.flowRunId ? await getFlowRun(db, task.flowRunId) : null;
  if (kind === 'continue' && (!task.flowRunId || run?.status === 'paused')) {
    return continueTask(db, taskId);
  }
  return task.flowRunId ? recoverFlowTask(db, task, run, kind, flowRuns) : restartTask(db, task);
}

async function requireActiveFlowAdmissionForTask(task: Task | null): Promise<void> {
  if (!task?.flowRunId) return;
  const { hasActiveFlowAdmission } = await import('../../flows/admission/runtime');
  if (!(await hasActiveFlowAdmission(task.flowRunId))) {
    // A refusal, not a fault: the phone answers it 409 with this message and does not report it.
    throw new PhoneSafeRefusal({
      code: 'PRECONDITION_FAILED',
      message:
        'This Flow run lost its place in the run queue. Continue or Retry it from the Queue.',
    });
  }
}

export const tasksRouter = router({
  ...taskSubChatProcedures,
  create: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1).optional().nullable(),
        description: z.string().min(1),
        source: taskSourceSchema.default('manual'),
        sourceId: z.string().optional().nullable(),
        requiresFilesystem: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }): Promise<Task> => {
      return createTask(getDatabase(), {
        projectId: input.projectId,
        description: input.description,
        source: input.source,
        sourceId: input.sourceId,
        requiresFilesystem: input.requiresFilesystem,
      });
    }),

  /**
   * Task for an already-open chat: an ordinary task that stashes chatId/subChatId in `result`
   * so the renderer can reattach the run to the chat that asked for it.
   */
  createForRemoteChat: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        chatId: z.string().min(1),
        subChatId: z.string().min(1),
        message: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      return createTask(getDatabase(), {
        projectId: input.projectId,
        description: input.message,
        source: 'chat-continuation',
        requiresFilesystem: true,
        result: { chatId: input.chatId, subChatId: input.subChatId },
      });
    }),

  getById: publicProcedure
    .input(z.string().min(1))
    .query(async ({ input }): Promise<TaskWithRunOutcome | null> =>
      getTaskWithRunOutcome(getDatabase(), input),
    ),

  listPending: publicProcedure.query(async (): Promise<Task[]> => {
    const ids = await getPendingTaskIds(getDatabase());
    const rows: Task[] = [];
    for (const { id } of ids) {
      const row = await getTaskById(getDatabase(), id);
      if (row) rows.push(row);
    }
    return rows;
  }),

  /** Dispatches a renderer missed while it was not listening; only still-running tasks. */
  listUndeliveredDispatches: publicProcedure.query(async (): Promise<TaskChatReadyData[]> => {
    const dispatches = listUndeliveredDispatches();
    const tasks = await Promise.all(dispatches.map((d) => getTaskById(getDatabase(), d.taskId)));
    // Re-check after the awaits: a send that landed meanwhile must not be handed out again.
    return dispatches.filter(
      (d, i) => tasks[i]?.status === 'running' && isDispatchPending(d.subChatId, d.taskId),
    );
  }),

  updateStatus: publicProcedure
    .input(
      z.object({
        taskId: z.string().min(1),
        status: taskStatusSchema,
        result: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<Task | null> => {
      const task = await updateTaskStatus(getDatabase(), input.taskId, input.status, {
        result: input.result,
        executedBy: hostname(),
      });
      return task;
    }),

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

  complete: publicProcedure
    .input(z.object({ taskId: z.string().min(1), result: z.unknown().optional() }))
    .mutation(async ({ input }): Promise<Task | null> => {
      const task = await updateTaskStatus(getDatabase(), input.taskId, 'completed', {
        result: input.result,
        executedBy: hostname(),
      });
      // Accepting a flow task accepts the whole run: sibling `done` rows must flip too, or the
      // queue's representative pick keeps surfacing the flow as Ready for review.
      if (task?.flowRunId) await completeDoneTasksForFlowRun(getDatabase(), task.flowRunId);
      return task;
    }),

  fail: publicProcedure
    .input(z.object({ taskId: z.string().min(1), error: z.string().optional() }))
    .mutation(async ({ input }): Promise<Task | null> => {
      const task = await updateTaskStatus(getDatabase(), input.taskId, 'failed', {
        result: input.error === undefined ? {} : { error: input.error },
        executedBy: hostname(),
      });
      return task;
    }),

  markForReview: publicProcedure
    .input(
      z.object({
        taskId: z.string().min(1),
        chatId: z.string().optional(),
        summary: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<Task | null> => {
      const result: Record<string, string> = {};
      if (input.chatId !== undefined) result.chatId = input.chatId;
      if (input.summary !== undefined) result.summary = input.summary;
      const task = await updateTaskStatus(getDatabase(), input.taskId, 'plan_ready', {
        result,
        executedBy: hostname(),
      });
      return task;
    }),

  startExecution: publicProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<Task | null> => {
      const db = getDatabase();
      await requireActiveFlowAdmissionForTask(await getTaskById(db, input.taskId));
      const { task, reason } = await startExecutionFromReviewDetailed(db, input.taskId, hostname());
      if (!task) {
        throwTaskMutationReason(reason, {
          notFound: 'Task not found',
          invalidState: 'Only reviewed plans can be started',
          fallback: 'Could not start execution',
        });
      }
      return task;
    }),

  listPaginated: publicProcedure
    .input(
      z
        .object({
          status: taskFilterStatusSchema.optional(),
          statuses: z.array(taskFilterStatusSchema).min(1).optional(),
          limit: z.number().min(1).max(200).default(50),
          cursor: paginatedCursorSchema.nullable().optional(),
          // Work queue collapses a multi-agent flow to one item; other callers omit it.
          collapseByFlow: z.boolean().optional(),
          workQueueSection: workQueueSectionSchema.optional(),
        })
        .refine((v) => !(v.status && v.statuses?.length), {
          message: 'Use either status or statuses, not both',
          path: ['statuses'],
        })
        .refine((v) => !(v.workQueueSection && (v.status || v.statuses?.length)), {
          message: 'Work Queue section cannot be combined with status filters',
          path: ['workQueueSection'],
        }),
    )
    .query(async ({ input }) => {
      const db = getDatabase();
      const page = await listTasksWithProjectPaginated(db, {
        status: input.status,
        statuses: input.statuses,
        limit: input.limit,
        cursor: input.cursor ?? null,
        collapseByFlow: input.collapseByFlow,
        workQueueSection: input.workQueueSection,
      });
      return { ...page, items: await withStoppedTaskRecoveries(db, page.items) };
    }),

  listCounts: publicProcedure
    .input(z.object({ collapseByFlow: z.boolean().optional() }).optional())
    .query(async ({ input }) =>
      getTaskCounts(getDatabase(), { collapseByFlow: input?.collapseByFlow }),
    ),

  workQueueOverviewCounts: publicProcedure.query(async () =>
    getWorkQueueOverviewCounts(getDatabase()),
  ),

  delete: publicProcedure
    .input(z.string().min(1))
    .mutation(async ({ input: taskId }): Promise<DeleteTaskResult> =>
      deleteTaskDetailed(getDatabase(), taskId),
    ),

  cancel: publicProcedure
    .input(z.string().min(1))
    .mutation(async ({ input: taskId }): Promise<Task | null> => {
      const { task, reason } = await cancelWorkQueueTask(getDatabase(), taskId);
      if (!task) {
        throwTaskMutationReason(reason, {
          notFound: 'Task not found',
          invalidState: 'Task cannot be cancelled in its current status',
          fallback: 'Could not cancel task',
        });
      }
      return task;
    }),

  cancelAllPending: publicProcedure.mutation(async () => cancelAllPendingTasks(getDatabase())),

  completeAllDone: publicProcedure.mutation(async () => completeAllDoneTasks(getDatabase())),

  deleteMatching: publicProcedure
    .input(deleteMatchingInputSchema)
    .mutation(async ({ input }): Promise<{ deletedCount: number }> => {
      const count = await deleteTasksMatchingStatuses(getDatabase(), input.statuses);
      return { deletedCount: count };
    }),

  reassign: publicProcedure
    .input(
      z.object({
        taskId: z.string().min(1),
        projectId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }): Promise<Task | null> => {
      const { task, reason } = await reassignTaskDetailed(
        getDatabase(),
        input.taskId,
        input.projectId,
      );
      if (!task) {
        throwTaskMutationReason(reason, {
          notFound: 'Task or target project not found',
          invalidState: 'Only pending tasks can be reassigned',
          flowShellNotReassignable:
            'This task is a flow-linked shell task and cannot be reassigned',
          fallback: 'Could not reassign task',
        });
      }
      return task;
    }),

  // === Poller Control (unchanged: poller singleton owns its lifecycle) ===

  pollerStatus: publicProcedure.query(async () => {
    const poller = getTaskPoller();
    return { isRunning: poller.isRunning() };
  }),

  startPoller: publicProcedure.mutation(async () => {
    const poller = getTaskPoller();
    await poller.start();
    return { success: true, isRunning: poller.isRunning() };
  }),

  stopPoller: publicProcedure.mutation(async () => {
    const poller = getTaskPoller();
    poller.stop();
    return { success: true, isRunning: poller.isRunning() };
  }),

  pausePoller: publicProcedure.mutation(async () => {
    const poller = getTaskPoller();
    poller.pause();
    return { success: true };
  }),

  resumePoller: publicProcedure.mutation(async () => {
    const poller = getTaskPoller();
    poller.resume();
    return { success: true };
  }),
});
