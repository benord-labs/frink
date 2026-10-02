import { eq } from 'drizzle-orm';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { getDatabase } from '../../db';
import { setNodeRunStatus } from '../../db/repos/node-runs';
import { updateTaskStatus } from '../../db/repos/tasks';
import { nodeRuns, type Task } from '../../db/schema';
import { resolveTaskSignalTransition } from '../../trpc/routers/frink-task-signal';
import { readRunFence, setFencedRunStatus } from './fence';

type Db = ReturnType<typeof getDatabase>;

export type HeldQuestionTask = Pick<Task, 'id' | 'result' | 'flowRunId' | 'nodeRunId'>;

/** Rolls the flow-side writes back inside `runTransition` when the task half lost its CAS. */
export class HeldQuestionParkDeclined extends Error {}

/**
 * Parks a question held at a crash as its expiry would have, mirroring advance.ts `parkAwaitingInput`.
 *
 * Writes nothing unless the run can be paused: a question on a run the sweeps cancel can't resume it.
 */
export function parkHeldQuestionCommand(
  db: Db,
  task: HeldQuestionTask,
  signal: TaskSignalPayload,
): boolean {
  const { flowRunId, nodeRunId } = task;
  if (flowRunId && nodeRunId) {
    const fence = readRunFence(db, flowRunId);
    const node = db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get();
    const nodeParkable = node?.status === 'running' || node?.status === 'awaiting_input';
    if (!fence || !nodeParkable || node.flowRunId !== flowRunId) return false;
    setNodeRunStatus(db, nodeRunId, 'awaiting_input', {
      completedAt: new Date(),
      expectStatuses: ['running'],
      expectFlowRunId: flowRunId,
    });
    setFencedRunStatus(db, fence, 'paused', {}, ['running']);
  }
  const parked = updateTaskStatus(db, task.id, 'needs_attention', {
    result: resolveTaskSignalTransition(task, signal).result,
    expectStatuses: ['running'],
  });
  // A task that already left `running` must not leave its node and run parked behind it.
  if (!parked && flowRunId && nodeRunId) throw new HeldQuestionParkDeclined();
  return parked !== null;
}
