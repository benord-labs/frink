/**
 * Sub-chat-scoped task queries, spread into the tasks router (client paths unchanged): the
 * queries that resolve WHICH task/run a sub-chat's bottom surfaces act on.
 */

import { z } from 'zod';
import { taskResultSchema, type TaskResultRecord } from '../../../../shared/types/task-result';
import { getDatabase } from '../../db';
import { getActiveFlowRunForSubChat, getFlowRun } from '../../db/repos/flow-runs';
import { getSubChatMode } from '../../db/repos/sub-chats';
import {
  getFlowChatForNodeRun,
  getLatestFlowTaskForSubChat,
  getTaskById,
} from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import { publicProcedure } from '../index';

type Db = ReturnType<typeof getDatabase>;

type SurfaceTask = Omit<Task, 'result' | 'triggerContext'> & {
  result: TaskResultRecord | null;
  triggerContext: TaskResultRecord | null;
};

function parseSurfaceTask(task: Task | null): SurfaceTask | null {
  if (!task) return null;
  return {
    ...task,
    result: taskResultSchema.nullable().parse(task.result),
    triggerContext: taskResultSchema.nullable().parse(task.triggerContext),
  };
}

/** A flow task stamped with its run's status: TaskAcceptBar accepts only on a COMPLETED run and
 * TaskControls keys Retry / Carry on off it, batch member or not. Non-flow tasks are unstamped. */
export type TaskWithRunOutcome = Task & { flowRunStatus?: string };

export async function getTaskWithRunOutcome(
  db: Db,
  taskId: string,
): Promise<TaskWithRunOutcome | null> {
  const task = await getTaskById(db, taskId);
  if (!task?.flowRunId) return task;
  const run = await getFlowRun(db, task.flowRunId);
  return run ? { ...task, flowRunStatus: run.status } : task;
}

export const taskSubChatProcedures = {
  /**
   * The ONE task every chat-level RunStatusRow acts on — accept (TaskAcceptBar) and Retry /
   * Carry-on (TaskControls) both resolve through this, so their rows stay mutually exclusive by
   * construction (one task, disjoint status branches). Resolution: the NEWEST flow task of the
   * sub-chat (terminal included — a later node's failed task must win over the chat's pinned
   * first-agent task, which chats.taskId freezes at link time), falling back to the pinned task
   * for non-flow chats. Run-enriched so both gates can read flowRunStatus.
   */
  getActionableTaskForSubChat: publicProcedure
    .input(z.object({ subChatId: z.string().min(1), fallbackTaskId: z.string().nullable() }))
    .query(async ({ input }): Promise<TaskWithRunOutcome | null> => {
      const db = getDatabase();
      // `run` first (mirrors getDrivingTaskForSubChat): a run starting between the two reads then
      // yields a task the run-scope check rejects — one null tick, self-healing — rather than
      // locking onto the previous run's stale task.
      const run = await getActiveFlowRunForSubChat(db, input.subChatId);
      const latest = await getLatestFlowTaskForSubChat(db, input.subChatId);
      if (!latest) {
        return input.fallbackTaskId ? getTaskWithRunOutcome(db, input.fallbackTaskId) : null;
      }
      // Sub-chats are reused across runs, so a LIVE run scopes the result: during a new run's
      // taskless window the PREVIOUS run's terminal task must not surface accept/retry for a
      // superseded run. A task of the live run itself (e.g. a failed batch member) passes; with
      // no live run, the newest flow task is the actionable one. The pinned fallback is not
      // substituted here — it is even staler.
      if (run && latest.flowRunId !== run.id) return null;
      return getTaskWithRunOutcome(db, latest.id);
    }),

  /**
   * The PAIR driving a sub-chat's flow-chat bottom surface: `run` (the live flow run, resolved
   * RUN-side so it survives the taskless windows between nodes that no task row can represent)
   * supplies LIVENESS; `task` (the newest task of THAT run, terminal included) picks WHICH surface.
   *
   * `subChatMode` is the chat's LIVE mode, which the task rows cannot report: an auto-approved plan
   * node implements in the same turn that planned, and the executor flips the sub-chat to `agent`
   * without rewriting the task's dispatch config. Read here rather than from the renderer's mode
   * atom, which is per-window and keyed on the PARENT chat id — the wrong grain for a split pane
   * showing two sub-chats of one chat.
   *
   * `task` uses `getLatestFlowTaskForSubChat`, NOT `getFlowDriveInfoForSubChat`: the latter filters
   * to FLOW_DRIVING_STATUSES, so it cannot tell a `cancelled` task — a restart-interrupted run,
   * whose composer IS its resume surface (decision `flow-run-restart-recovery`) — from the genuine
   * taskless window, which must keep the strip. Scoped to `run.id` so a reused chat never reports
   * the previous run's task. `fallbackTaskId` (the pinned, first-agent-wins task) substitutes ONLY
   * with no live run — its one job is the non-flow/standalone parked task. Under a live run it holds
   * the FIRST node's TERMINAL task; substituting that made "no driving task" indistinguishable from
   * "terminal driving task", and the composer came back mid-run.
   */
  getDrivingTaskForSubChat: publicProcedure
    .input(z.object({ subChatId: z.string().min(1), fallbackTaskId: z.string().nullable() }))
    .query(async ({ input }) => {
      const db = getDatabase();
      // `run` first: a run terminalizing between the two reads yields {run: live, task: null} — one
      // tick of the strip, self-healing — rather than {run: null, task: a stale driver}.
      const run = await getActiveFlowRunForSubChat(db, input.subChatId);
      const latest = run ? await getLatestFlowTaskForSubChat(db, input.subChatId) : null;
      const id = run ? (latest?.flowRunId === run.id ? latest.id : null) : input.fallbackTaskId;
      const task = id ? await getTaskById(db, id) : null;
      return {
        run,
        task: parseSurfaceTask(task),
        subChatMode: await getSubChatMode(db, input.subChatId),
      };
    }),

  /**
   * The chat behind a flow node_run — powers the Runs-tab "Answer" jump for an awaiting_input
   * park. Answering itself stays in chat (ParkAnswerSurface): quick-pick-or-jump ruling.
   */
  getFlowChatForNodeRun: publicProcedure
    .input(z.object({ nodeRunId: z.string().min(1) }))
    .query(async ({ input }) => getFlowChatForNodeRun(getDatabase(), input.nodeRunId)),
};
