import { eq } from 'drizzle-orm';
import { type TaskResultRecord, taskResultSchema } from '../../../../shared/types/task-result';
import type { getDatabase } from '../../db';
import { resumeQuietIdlePark } from '../../db/repos/task-parking/quiet-marker';
import { scrubResumedResult } from '../../db/repos/task-parking/resume-scrub';
import { parseResultRecord, updateTaskStatus } from '../../db/repos/tasks';
import { type NodeRun, type Task, tasks } from '../../db/schema';
import { flowStillRunning, reviveMarkedNode, unparkFlowCommand } from './unpark';

type Db = ReturnType<typeof getDatabase>;

/** Who brought the task back: a user's follow-up message, or the agent's own wake burst. */
export type ResumedBy = 'follow_up_message' | 'wake_burst';

export type ParkedTask = Pick<Task, 'id' | 'status' | 'result' | 'flowRunId' | 'nodeRunId'>;

type ResumedTask = { node: NodeRun | null; flowLive: boolean };

/** Rolls back a wake's task write inside its savepoint when the flow cannot follow. */
class WakeDeclined extends Error {}

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

/** Revives a restart-interrupted run in place for a chat follow-up: its cancelled driving task and
 * marked node back to running. The follow-up turn continues the work, so nothing is re-dispatched. */
export function reviveInPlaceCommand(
  db: Db,
  taskId: string,
  flowRunId: string,
  now = new Date(),
): NodeRun | null {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task?.status !== 'cancelled') return null;
  const node = reviveMarkedNode(db, flowRunId);
  if (node) {
    updateTaskStatus(db, taskId, 'running', {
      result: resumedResult(task, 'follow_up_message', now),
      expectStatuses: ['cancelled'],
    });
  }
  return node;
}

/** A parked task back to running together with its flow; null when the task left its park. A
 * follow-up keeps the task running when the flow cannot follow; a wake then writes nothing. */
export function resumeParkedTaskCommand(
  db: Db,
  task: ParkedTask,
  resumedBy: ResumedBy,
  now = new Date(),
): ResumedTask | null {
  try {
    return db.transaction(() => resumeTaskThenFlow(db, task, resumedBy, now));
  } catch (error) {
    if (error instanceof WakeDeclined) return null;
    throw error;
  }
}

function resumeTaskThenFlow(
  db: Db,
  task: ParkedTask,
  resumedBy: ResumedBy,
  now: Date,
): ResumedTask | null {
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
  if (!flowLive && !followUp) throw new WakeDeclined();
  return { node, flowLive };
}
