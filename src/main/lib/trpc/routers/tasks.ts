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
import { z } from 'zod';
import type { TaskChatReadyData } from '../../../../shared/types/task-chat-ready';
import { getDatabase } from '../../db';
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
  type TaskMutationFailureReason,
  updateTaskStatus,
} from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import type { CarryOnFlowTaskResult } from '../../flows/rerun';
import {
  isDispatchPending,
  listUndeliveredDispatches,
} from '../../task-executor/dispatch-registry';
import { getTaskPoller } from '../../task-poller';
import { cancelWorkQueueTask } from '../../tasks/cancel-work-queue-task';
import { publicProcedure, router } from '../index';
import {
  getTaskWithRunOutcome,
  type TaskWithRunOutcome,
  taskSubChatProcedures,
} from './tasks-subchat';

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

function throwTaskMutationReason(
  reason: TaskMutationFailureReason | undefined,
  messages: {
    notFound: string;
    invalidState: string;
    fallback: string;
    flowShellNotReassignable?: string;
  },
): never {
  if (reason === 'not_found') throw new Error(messages.notFound);
  if (reason === 'flow_shell_not_reassignable') {
    throw new Error(
      messages.flowShellNotReassignable ??
        'This task is a flow-linked shell task and cannot be reassigned',
    );
  }
  if (reason === 'invalid_state') throw new Error(messages.invalidState);
  throw new Error(messages.fallback);
}

/** Maps a `carryOnFlowTask` failure to the same user-facing message each retry surface showed. */
function throwCarryOnReason(
  reason: Extract<CarryOnFlowTaskResult, { ok: false }>['reason'],
): never {
  const messages: Record<typeof reason, string> = {
    'not-found': 'Task not found',
    'no-session':
      'Nothing to carry on — the failed attempt has no resumable session. Use Retry to run it again.',
    'invalid-state': 'Only failed or attention-parked tasks can be retried',
    'chat-archived': "This task's chat is archived. Restore the chat to carry on, or use Retry.",
    'admission-required':
      "Carry on isn't available for this run anymore — it lost its place in the run queue. Use Retry to continue from the last step.",
    superseded: 'This attempt was replaced by a newer one. Carry on from the latest attempt.',
  };
  throw new Error(messages[reason]);
}

async function requireActiveFlowAdmissionForTask(task: Task | null): Promise<void> {
  if (!task?.flowRunId) return;
  const { hasActiveFlowAdmission } = await import('../../flows/admission/runtime');
  if (!(await hasActiveFlowAdmission(task.flowRunId))) {
    throw new Error(
      'This Flow run lost its place in the run queue. Open the Flow run and use Resume or Retry there.',
    );
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
   * User-requested retry of a failed/parked task. Server-side so the scrub + CAS live in one
   * place (repos/tasks.ts retryTaskDetailed) and the claim path can read `retryMode` to resume
   * the persisted Claude session ('continue') or provision fresh ('restart').
   */
  retry: publicProcedure
    .input(
      z.object({
        taskId: z.string().min(1),
        mode: z.enum(['continue', 'restart']).default('continue'),
      }),
    )
    .mutation(async ({ input }): Promise<Task> => {
      const db = getDatabase();
      // Carry on = session-resume + batch bookkeeping + task flip, all in one shared primitive so the
      // chat and batch surfaces stay in lockstep. Restart provisions fresh via retryTaskDetailed.
      // Dynamic import mirrors this router's other flows/rerun uses (avoids a static import cycle).
      if (input.mode === 'continue') {
        const { carryOnFlowTask } = await import('../../flows/rerun');
        const res = await carryOnFlowTask(db, input.taskId);
        if (!res.ok) throwCarryOnReason(res.reason);
        return res.task;
      }
      const { task, reason } = await retryTaskDetailed(db, input.taskId, input.mode);
      if (!task) {
        throwTaskMutationReason(reason, {
          notFound: 'Task not found',
          invalidState: 'Only failed or attention-parked tasks can be retried',
          fallback: 'Could not retry task',
        });
      }
      return task;
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
      return listTasksWithProjectPaginated(getDatabase(), {
        status: input.status,
        statuses: input.statuses,
        limit: input.limit,
        cursor: input.cursor ?? null,
        collapseByFlow: input.collapseByFlow,
        workQueueSection: input.workQueueSection,
      });
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
