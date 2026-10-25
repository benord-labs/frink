/** The claim side of a paused run's resume: once its ticket holds the slot again, the step continues
 * in place. Loaded only for its registration, so the step verbs it calls never import it back. */

import { desc, eq } from 'drizzle-orm';
import log from 'electron-log';
import { getDatabase } from '../../../db';
import { tasks } from '../../../db/schema';
import { readRunFence } from '../../transitions';
import { captureFlowAdmissionException } from '../activity';
import { registerTerminalFlowResumeDispatcher } from '../runtime';
import type { TerminalFlowResumeIntent } from './resume-store';

type Db = ReturnType<typeof getDatabase>;

function latestNodeTask(db: Db, nodeRunId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.nodeRunId, nodeRunId))
    .orderBy(desc(tasks.createdAt))
    .get();
}

async function continueParkedStep(intent: TerminalFlowResumeIntent, ticket: number): Promise<void> {
  const db = getDatabase();
  const { flow_run_id: flowRunId, node_run_id: nodeRunId } = intent;
  // A Cancel that committed after the claim owns the run; its release settles this ticket.
  if (!readRunFence(db, flowRunId, ticket)) return;
  if (intent.resume_action) {
    const { resumeFlowRun } = await import('../../resume');
    await resumeFlowRun(
      flowRunId,
      intent.resume_action,
      nodeRunId,
      undefined,
      intent.recovery_kind,
    );
    return;
  }
  const task = latestNodeTask(db, nodeRunId);
  if (!task) throw new Error(`Paused step ${nodeRunId} has no task to continue`);
  if (task.status === 'needs_attention') {
    const { carryOnFlowTask } = await import('../../rerun/carry-on');
    const outcome = await carryOnFlowTask(db, task.id);
    if (!outcome.ok)
      throw new Error(`Paused step ${nodeRunId} did not continue: ${outcome.reason}`);
    return;
  }
  // The task settled while the run held no slot (e.g. Mark complete): advance its node now.
  const { setFlowRunStatus } = await import('../../../db/repos/flow-runs');
  const { advanceTerminalTask } = await import('../../task-completion-watcher');
  // A Cancel that landed since the fence read leaves the run as it is.
  if (!(await setFlowRunStatus(db, flowRunId, 'running', {}, 'paused'))) return;
  await advanceTerminalTask(db, task);
}

/** Never throws: a failure leaves the run paused, and the claim's own activity release returns the
 * slot while the run still only waits for a person. */
async function dispatchParkedResume(
  intent: TerminalFlowResumeIntent,
  ticket: number,
): Promise<void> {
  try {
    await continueParkedStep(intent, ticket);
  } catch (error) {
    captureFlowAdmissionException(error, 'parked-resume');
    log.warn('[FlowAdmission] paused run resume did not continue its step', {
      flowRunId: intent.flow_run_id,
      ticket,
      error,
    });
  }
}

registerTerminalFlowResumeDispatcher(dispatchParkedResume, true);
