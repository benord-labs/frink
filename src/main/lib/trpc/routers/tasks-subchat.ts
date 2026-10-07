/**
 * Sub-chat-scoped task queries, spread into the tasks router (client paths unchanged): the
 * queries that resolve WHICH task/run a sub-chat's bottom surfaces act on.
 */

import { z } from 'zod';
import {
  type RecoveryKind,
  type RunRecovery,
  recoveryKindSchema,
} from '../../../../shared/types/flow-run/resume';
import { taskResultSchema, type TaskResultRecord } from '../../../../shared/types/task-result';
import { getDatabase } from '../../db';
import { getActiveFlowRunForSubChat, getFlowRun } from '../../db/repos/flow-runs';
import { getSubChatMode } from '../../db/repos/sub-chats';
import {
  getFlowChatForNodeRun,
  getLatestFlowTaskForSubChat,
  getTaskById,
  parseResultRecord,
} from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import type { SettledRun } from '../../flows/transitions';
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

/** A flow task stamped with its run's status: TaskAcceptBar accepts only on a COMPLETED run, batch
 * member or not. Non-flow tasks are unstamped. `recoveryKind` is set only on a stopped task. */
export type TaskWithRunOutcome = Task & {
  flowRunStatus?: string;
  recoveryKind?: RecoveryKind;
  /** Its Retry re-runs a started non-agent step, so it confirms first. */
  confirmSideEffects?: boolean;
  /** The run's stopped step this task recovers through, when that is not the task itself. */
  recoveryNodeRunId?: string;
};

type RecoveryCandidate = Pick<Task, 'id' | 'status' | 'flowRunId' | 'result'> & {
  flowRunStatus?: string | null;
  /** The queue's derived status; `interrupted` marks a run a restart cancelled. */
  effectiveStatus?: string;
};

const isStoppedTask = (c: RecoveryCandidate) =>
  c.status === 'failed' || c.status === 'needs_attention';

/** The run a row recovers through when its own task is not the stopped step: a restart cancelled
 * the run, or the failed run stopped on a later step without a task (non-agent). */
function stoppedRunOf(c: RecoveryCandidate): SettledRun | undefined {
  if (!c.flowRunId) return undefined;
  if (c.effectiveStatus === 'interrupted') return { id: c.flowRunId, status: 'cancelled' };
  const failedLater = c.effectiveStatus === 'failed' && !isStoppedTask(c);
  return failedLater ? { id: c.flowRunId, status: 'failed' } : undefined;
}

/** Each such row's recovery: its run's stopped step, as the run history shows it. */
async function stoppedRunRecoveries(
  db: Db,
  candidates: readonly RecoveryCandidate[],
): Promise<Map<string, RunRecovery>> {
  const runOf = new Map<string, SettledRun>();
  for (const c of candidates) {
    const run = stoppedRunOf(c);
    if (run) runOf.set(c.id, run);
  }
  if (runOf.size === 0) return new Map();
  // One batched lookup for the page's runs, however many of them stopped.
  const runs = new Map([...runOf.values()].map((run) => [run.id, run]));
  const { resolveSettledRunRecoveries } = await import('../../flows/rerun/recovery-kind');
  const byRun = resolveSettledRunRecoveries(db, [...runs.values()]);
  const recoveries = new Map<string, RunRecovery>();
  for (const [taskId, run] of runOf) {
    const step = byRun.get(run.id);
    if (step) recoveries.set(taskId, step);
  }
  return recoveries;
}

/** Each stopped task's one recovery; `runSteps` holds the rows that recover through their run's
 * stopped step. */
type TaskRecoveries = { kinds: Map<string, RecoveryKind>; runSteps: Map<string, RunRecovery> };

/** The one recovery action each stopped (failed, parked, interrupted) task offers, if any. */
export async function stoppedTaskRecoveries(
  db: Db,
  candidates: readonly RecoveryCandidate[],
): Promise<TaskRecoveries> {
  // A run still in flight has no recovery to carry out: it pauses or settles first.
  const stopped = candidates.filter(
    (t) =>
      isStoppedTask(t) &&
      t.effectiveStatus !== 'interrupted' &&
      t.flowRunStatus !== 'pending' &&
      t.flowRunStatus !== 'running',
  );
  // Dynamic import mirrors the tasks router's flows uses (avoids a static import cycle).
  const { resolveRecoveryKinds } = await import('../../flows/rerun/recovery-kind');
  const kinds = resolveRecoveryKinds(db, stopped);
  const runSteps = await stoppedRunRecoveries(db, candidates);
  for (const [id, step] of runSteps) kinds.set(id, step.kind);
  return { kinds, runSteps };
}

/** Stamps each row with its recovery, as the Work Queue lists it; `recoveryNodeRunId` names the
 * attempt a run-level recovery acts on, so a confirm asked about it never carries to the next. */
export async function withStoppedTaskRecoveries<T extends RecoveryCandidate>(
  db: Db,
  items: readonly T[],
) {
  const { kinds, runSteps } = await stoppedTaskRecoveries(db, items);
  return items.map((item) => ({
    ...item,
    recoveryKind: kinds.get(item.id),
    confirmSideEffects: runSteps.get(item.id)?.confirmSideEffects === true,
    recoveryNodeRunId: runSteps.get(item.id)?.nodeRunId,
  }));
}

/** One task's recovery by the Work Queue's rule: a cancelled run reads as its interrupted row (a
 * user Stop recovers nothing) and a failed run recovers through its stopped step. */
function taskRecoveries(db: Db, outcome: TaskWithRunOutcome): Promise<TaskRecoveries> {
  const { flowRunStatus } = outcome;
  const effectiveStatus = flowRunStatus === 'cancelled' ? 'interrupted' : flowRunStatus;
  return stoppedTaskRecoveries(db, [{ ...outcome, effectiveStatus }]);
}

async function stampRecovery(db: Db, outcome: TaskWithRunOutcome): Promise<void> {
  const recovery = await taskRecoveries(db, outcome);
  const step = recovery.runSteps.get(outcome.id);
  if (step) return stampRunStep(db, outcome, step);
  const recoveryKind = recovery.kinds.get(outcome.id);
  if (recoveryKind) outcome.recoveryKind = recoveryKind;
}

/** A run-level recovery shows in the chat its stopped step ran in, or in every chat of the run
 * when that step has no chat (non-agent); a fan-out's other lanes run in chats of their own. */
async function stampRunStep(db: Db, outcome: TaskWithRunOutcome, step: RunRecovery): Promise<void> {
  const stepChat = await getFlowChatForNodeRun(db, step.nodeRunId);
  const ownSubChatId = parseResultRecord(outcome.result).subChatId;
  if (stepChat?.subChatId && stepChat.subChatId !== ownSubChatId) return;
  outcome.recoveryKind = step.kind;
  outcome.recoveryNodeRunId = step.nodeRunId;
  if (step.confirmSideEffects) outcome.confirmSideEffects = true;
}

async function getTaskWithRunStatus(db: Db, taskId: string): Promise<TaskWithRunOutcome | null> {
  const task = await getTaskById(db, taskId);
  if (!task) return null;
  const run = task.flowRunId ? await getFlowRun(db, task.flowRunId) : null;
  const outcome: TaskWithRunOutcome = { ...task };
  if (run) outcome.flowRunStatus = run.status;
  return outcome;
}

export async function getTaskWithRunOutcome(
  db: Db,
  taskId: string,
): Promise<TaskWithRunOutcome | null> {
  const outcome = await getTaskWithRunStatus(db, taskId);
  if (outcome) await stampRecovery(db, outcome);
  return outcome;
}

/** tasks.recover input; `recoveryNodeRunId` pins the step attempt a confirmation asked about. */
export const recoverTaskInputSchema = z.object({
  taskId: z.string().min(1),
  kind: recoveryKindSchema,
  recoveryNodeRunId: z.string().min(1).optional(),
});

/** Refuses a recovery pinned to a step attempt that is no longer the one the task recovers through,
 * so a confirmation never carries over to a newer, unconfirmed step. */
export async function assertRecoveryStep(db: Db, taskId: string, expected?: string): Promise<void> {
  if (expected === undefined) return;
  const outcome = await getTaskWithRunStatus(db, taskId);
  const step = outcome && (await taskRecoveries(db, outcome)).runSteps.get(taskId);
  if (step?.nodeRunId === expected) return;
  const { recoveryChangedError } = await import('../../flows/rerun/recovery-kind');
  throw recoveryChangedError();
}

export const taskSubChatProcedures = {
  /**
   * The ONE task every chat-level RunStatusRow acts on — accept (TaskAcceptBar) and recovery
   * (TaskControls, keyed on `recoveryKind`) both resolve through this, so their rows stay mutually exclusive by
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
