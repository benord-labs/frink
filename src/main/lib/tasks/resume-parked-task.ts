import log from 'electron-log';
import type { DrivingTaskRow, ParkedTask, ResumedBy } from '../flows/transitions';
import { captureMainException, captureMainMessage } from '../sentry/init';

/** A parked task (`failed` | `needs_attention`) back to `running` with its node and run, in one
 * transaction. True when this resume won AND the flow is live again. */
export async function resumeParkedTaskInPlace(
  task: ParkedTask,
  resumedBy: ResumedBy,
  subChatId: string,
): Promise<boolean> {
  if (task.status !== 'failed' && task.status !== 'needs_attention') return false;
  try {
    const { getDatabase } = await import('../db');
    const { resumeParkedTaskCommand } = await import('../flows/transitions');
    const { transitionFlowRun } = await import('../flows/admission/runtime');
    const { forgetAdvancedTask } = await import('../flows/task-completion-watcher');
    const db = getDatabase();
    const command = () => resumeParkedTaskCommand(db, task, resumedBy);
    // A task with no Flow writes no admission or run row; it must not wait behind admission work.
    const resumed = task.flowRunId
      ? await transitionFlowRun(command, (applied) => {
          if (applied) forgetAdvancedTask(task.id);
        })
      : command();
    if (!resumed) {
      log.info('[TaskResume] skipped — task left resumable status', { subChatId, taskId: task.id });
      return false;
    }
    if (resumed.node && task.flowRunId) {
      const { emitUnparked } = await import('../flows/rerun/unpark-node-run');
      await emitUnparked(task.flowRunId, resumed.node);
    }
    if (!resumed.flowLive) {
      captureMainMessage('Task resumed but its flow did not follow', 'warning', {
        taskId: task.id,
        resumedBy,
      });
    }
    return resumed.flowLive;
  } catch (error) {
    // Unattended on the burst path, where a failure would otherwise go unseen.
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

/** Un-park the flow behind an already-running task, while the task is still the row the caller
 * read. A paused node, or (with `failedRunFallback`) a failed run; nothing to un-park is live too. */
export async function unparkFlowInPlace(
  flowRunId: string,
  nodeRunId: string | null,
  taskId: string,
  taskRow: DrivingTaskRow | undefined,
  failedRunFallback: boolean,
): Promise<boolean> {
  const { getDatabase } = await import('../db');
  const { flowStillRunning, unparkFlowCommand } = await import('../flows/transitions');
  const { commitUnpark } = await import('../flows/rerun/unpark-node-run');
  const db = getDatabase();
  const unparked = await commitUnpark(
    flowRunId,
    () => unparkFlowCommand(db, flowRunId, nodeRunId, taskRow, failedRunFallback),
    taskId,
  );
  return unparked || flowStillRunning(db, flowRunId, nodeRunId);
}
