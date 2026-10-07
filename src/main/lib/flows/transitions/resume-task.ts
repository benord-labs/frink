import { type TaskResultRecord, taskResultSchema } from '../../../../shared/types/task-result';
import type { getDatabase } from '../../db';
import { resumeQuietIdlePark } from '../../db/repos/task-parking/quiet-marker';
import { scrubResumedResult } from '../../db/repos/task-parking/resume-scrub';
import { parseResultRecord, updateTaskStatus } from '../../db/repos/tasks';
import type { NodeRun, Task } from '../../db/schema';
import { flowStillRunning, unparkFlowCommand } from './unpark';

type Db = ReturnType<typeof getDatabase>;

/** Who brought the task back: a user's follow-up message, or the agent's own wake burst. */
export type ResumedBy = 'follow_up_message' | 'wake_burst';

export type ParkedTask = Pick<Task, 'id' | 'status' | 'result' | 'flowRunId' | 'nodeRunId'>;

type ResumedTask = { node: NodeRun | null; flowLive: boolean };

/** Rolls back a wake's (or a plan approval's) task write inside its savepoint when the flow
 * cannot follow. */
class ResumeDeclined extends Error {}

/** A chat reply approving a strict flow plan park (`flow-agent-node-mode`). Never a wake, and never
 * a flow-less task, whose plan review has its own path. */
export function isPlanApprovalResume(
  task: Pick<ParkedTask, 'status' | 'flowRunId'>,
  resumedBy: ResumedBy,
): boolean {
  return task.status === 'plan_ready' && resumedBy === 'follow_up_message' && !!task.flowRunId;
}

/** The ended attempt's markers scrubbed, stamped with who resumed the task and when. */
function resumedResult(
  task: Pick<Task, 'status' | 'result'>,
  resumedBy: ResumedBy,
  now: Date,
): TaskResultRecord {
  return taskResultSchema.parse({
    ...scrubResumedResult(parseResultRecord(task.result)),
    resumedBy,
    resumedAt: now.toISOString(),
    previousStatus: task.status,
  });
}

/** A parked task back to running together with its flow; null when the task left its park. A
 * follow-up keeps the task running when the flow cannot follow; a wake or a plan approval then
 * writes nothing. */
export function resumeParkedTaskCommand(
  db: Db,
  task: ParkedTask,
  resumedBy: ResumedBy,
  now = new Date(),
): ResumedTask | null {
  try {
    return db.transaction(() => resumeTaskThenFlow(db, task, resumedBy, now));
  } catch (error) {
    if (error instanceof ResumeDeclined) return null;
    throw error;
  }
}

function resumeTaskThenFlow(
  db: Db,
  task: ParkedTask,
  resumedBy: ResumedBy,
  now: Date,
): ResumedTask | null {
  if (isPlanApprovalResume(task, resumedBy)) return approvePlanThenFlow(db, task, now);
  const result = resumedResult(task, resumedBy, now);
  // A wake holds only while the row is still the exact quiet-idle park it read.
  const resumed =
    resumedBy === 'wake_burst'
      ? resumeQuietIdlePark(db, task.id, task.result, result)
      : updateTaskStatus(db, task.id, 'running', {
          result,
          expectStatuses: ['failed', 'needs_attention'],
        });
  if (!resumed) return null;
  if (!task.flowRunId) return { node: null, flowLive: true };
  const followUp = resumedBy === 'follow_up_message';
  const node = unparkFlowCommand(db, task.flowRunId, task.nodeRunId, undefined, followUp);
  const flowLive = node !== null || flowStillRunning(db, task.flowRunId, task.nodeRunId);
  if (!flowLive && !followUp) throw new ResumeDeclined();
  return { node, flowLive };
}

/** Runs the approved plan in execute mode (`done` resolves `done`), only while its node is parked:
 * a panel Approve completes the node without touching the task, so a later reply no-ops. */
function approvePlanThenFlow(db: Db, task: ParkedTask, now: Date): ResumedTask | null {
  const result = {
    ...resumedResult(task, 'follow_up_message', now),
    startMode: 'execute' as const,
  };
  const resumed = updateTaskStatus(db, task.id, 'running', {
    result,
    expectStatuses: ['plan_ready'],
  });
  if (!resumed || !task.flowRunId) return null;
  const node = unparkFlowCommand(db, task.flowRunId, task.nodeRunId, undefined, false);
  if (!node) throw new ResumeDeclined();
  return { node, flowLive: true };
}
