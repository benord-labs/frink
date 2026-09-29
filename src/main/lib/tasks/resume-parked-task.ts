import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import log from 'electron-log';
import { taskResultSchema } from '../../../shared/types/task-result';
import { flowRuns, nodeRuns, type Task } from '../db/schema';
import type { DrivingTaskRow } from '../flows/rerun/unpark-node-run';
import { scrubResumedResult } from '../db/repos/task-parking/resume-scrub';
import { captureMainException, captureMainMessage } from '../sentry/init';

/** Who brought the task back: a user's follow-up message, or the agent's own wake burst. */
type ResumedBy = 'follow_up_message' | 'wake_burst';

type ResumableTask = {
  id: string;
  status: string;
  result: Task['result'];
  flowRunId: string | null;
  nodeRunId: string | null;
};

/** CAS a parked task (`failed` | `needs_attention`) back to `running`, evict the watcher's
 * advanced-set, un-park node + run in place. True when this CAS won AND the flow is live again. */
export async function resumeParkedTaskInPlace(
  task: ResumableTask,
  resumedBy: ResumedBy,
  subChatId: string,
): Promise<boolean> {
  if (task.status !== 'failed' && task.status !== 'needs_attention') return false;
  try {
    const { getDatabase } = await import('../db');
    const db = getDatabase();
    if (resumedBy === 'wake_burst' && !(await wakeRunIsOpen(db, task.flowRunId))) return false;
    const resumedAt = new Date().toISOString();
    const resumed = await casTaskRunning(db, task, resumedBy, resumedAt);
    if (!resumed) {
      log.info('[TaskResume] skipped — task left resumable status', {
        subChatId,
        taskId: task.id,
      });
      return false;
    }
    const { forgetAdvancedTask } = await import('../flows/task-completion-watcher');
    forgetAdvancedTask(task.id);
    if (!task.flowRunId) return true;
    const row = { id: task.id, status: resumed.status, result: resumed.result };
    return settleFlowAfterResume(db, task, task.flowRunId, resumedBy, row, resumedAt);
  } catch (error) {
    // Unattended on the burst path, where a task left `running` over a still-parked run is a
    // silent divergence nobody would otherwise see.
    captureMainException(error, { surface: 'resume-parked-task', resumedBy });
    log.error('[TaskResume] failed', {
      subChatId,
      taskId: task.id,
      resumedBy,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

type Db = Awaited<ReturnType<(typeof import('../db'))['getDatabase']>>;

/** A wake never resumes a task whose run is already over: nothing could follow the task CAS. */
async function wakeRunIsOpen(db: Db, flowRunId: string | null): Promise<boolean> {
  if (!flowRunId) return true;
  const { getFlowRun } = await import('../db/repos/flow-runs');
  const run = await getFlowRun(db, flowRunId);
  return !run || run.status === 'paused' || run.status === 'running';
}

/** The task CAS. A burst validated a quiet-idle park from a snapshot, so its write holds only while
 * the row is still that exact park; a user's follow-up resumes any park it read. */
async function casTaskRunning(
  db: Db,
  task: ResumableTask,
  resumedBy: ResumedBy,
  resumedAt: string,
): Promise<Task | null> {
  const { parseResultRecord, updateTaskStatus } = await import('../db/repos/tasks');
  const result = taskResultSchema.parse({
    ...scrubResumedResult(parseResultRecord(task.result)),
    resumedBy,
    resumedAt,
    previousStatus: task.status,
  });
  if (resumedBy === 'wake_burst') {
    const { resumeQuietIdlePark } = await import('../db/repos/task-parking/quiet-marker');
    return resumeQuietIdlePark(db, task.id, task.result, result);
  }
  return updateTaskStatus(db, task.id, 'running', {
    result,
    expectStatuses: ['failed', 'needs_attention'],
  });
}

/** Un-park the flow behind a task CAS that won. If the flow cannot follow, a wake puts the exact
 * park back — or, when the same execution's late signal already landed, re-opens the run instead. */
async function settleFlowAfterResume(
  db: Db,
  task: ResumableTask,
  flowRunId: string,
  resumedBy: ResumedBy,
  row: DrivingTaskRow,
  resumedAt: string,
): Promise<boolean> {
  let flowLive = false;
  try {
    const followUp = resumedBy === 'follow_up_message';
    flowLive = await unparkFlowInPlace(flowRunId, task.nodeRunId, task.id, row, followUp);
  } catch (error) {
    captureMainException(error, { surface: 'resume-parked-task', stage: 'flow-unpark' });
  }
  if (flowLive) return true;
  if (resumedBy === 'wake_burst') {
    const { replaceWakeResumedRow } = await import('../db/repos/task-parking/quiet-marker');
    const restored = await replaceWakeResumedRow(db, task.id, resumedAt, {
      status: 'needs_attention',
      result: task.result,
    });
    if (!restored) {
      const { unparkQuietIdleFlowRun } = await import('../flows/task-completion-watcher');
      await unparkQuietIdleFlowRun(db, task.id, flowRunId);
    }
  }
  captureMainMessage('Task resumed but its flow did not follow', 'warning', {
    taskId: task.id,
    resumedBy,
  });
  return false;
}

/** A FAILED run does not match the paused-run unpark, so fall back to the failed-run variant. Both
 * are CAS-guarded no-ops when they do not apply (the failed variant also refuses batch/fan-out). */
export async function unparkFlowInPlace(
  flowRunId: string,
  nodeRunId: string | null,
  taskId: string,
  /** The task row the un-park was decided on: the node write holds only while it is unchanged. */
  taskRow: DrivingTaskRow | undefined,
  /** A user's follow-up may also revive a FAILED run; the unattended wake path never does. */
  failedRunFallback: boolean,
): Promise<boolean> {
  const { resumeFailedFlowInPlace, resumeFlowNodeInPlace } = await import('../flows/resume');
  if (nodeRunId && (await resumeFlowNodeInPlace(flowRunId, nodeRunId, taskId, taskRow))) {
    return true;
  }
  if (failedRunFallback && (await resumeFailedFlowInPlace(flowRunId, taskId))) return true;
  if (!nodeRunId) return false;
  // Nothing to un-park is success too — but only when BOTH halves are live: the node was never
  // parked (the sweep's node write lost) and the run is running. A paused run stays a failure.
  const { getDatabase } = await import('../db');
  const { getNodeRun } = await import('../db/repos/node-runs');
  const { getFlowRun } = await import('../db/repos/flow-runs');
  const db = getDatabase();
  const [node, run] = await Promise.all([getNodeRun(db, nodeRunId), getFlowRun(db, flowRunId)]);
  if (node?.status !== 'running') return false;
  if (run?.status === 'running') return true;
  if (run?.status !== 'paused') return false;
  // Half-applied un-park (live node, paused run): ONE statement re-opens it — still paused AND
  // no node of the run parked (this one included) — so a concurrent park is never left under it.
  const parkedNode = db
    .select({ one: sql`1` })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.flowRunId, flowRunId),
        inArray(nodeRuns.status, ['awaiting_input', 'blocked']),
      ),
    );
  const [reopened] = await db
    .update(flowRuns)
    .set({ status: 'running' })
    .where(and(eq(flowRuns.id, flowRunId), eq(flowRuns.status, 'paused'), notExists(parkedNode)))
    .returning({ id: flowRuns.id });
  return Boolean(reopened);
}
