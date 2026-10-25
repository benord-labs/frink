/** Continue: resume a failed attempt's session in place instead of re-running the step. */

import { type RecoverOutcome, recoverOutcomeFor } from '../../../../shared/types/flow-run/resume';
import type { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { isTaskChatArchived } from '../../db/repos/task-queries/chat-archive-tasks';
import { isSupersededTask } from '../../db/repos/task-queries/flow-collapse';
import { getTaskById, retryTaskDetailed } from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import { withFlowResourceCleanup } from '../admission/activity';
import { withRecoveryKind } from './recovery-kind';

type Db = ReturnType<typeof getDatabase>;

export type CarryOnFlowTaskResult =
  /** `outcome`: set when the paused run had given its slot up and queued to take one back. */
  | { ok: true; task: Task; outcome?: RecoverOutcome }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'no-session'
        | 'invalid-state'
        | 'admission-required'
        | 'chat-archived'
        | 'superseded';
    };

/**
 * Continue ONE failed/parked task by resuming its persisted session ({@link withRecoveryKind}
 * gates on it). A paused Flow continues in place while it holds its slot; one that gave the slot up
 * while it waited queues to take it back, and continues once that resume is claimed.
 */
export async function carryOnFlowTask(db: Db, taskId: string): Promise<CarryOnFlowTaskResult> {
  const existing = await getTaskById(db, taskId);
  if (!existing) return { ok: false, reason: 'not-found' };

  // Reject stale UI actions before looking up their persisted session or touching retry state.
  if (existing.status !== 'failed' && existing.status !== 'needs_attention') {
    return { ok: false, reason: 'invalid-state' };
  }
  // Archiving stopped the chat's work; a turn into it would only be declined.
  if (isTaskChatArchived(db, existing)) return { ok: false, reason: 'chat-archived' };
  if (await isSupersededTask(db, taskId)) return { ok: false, reason: 'superseded' };

  const continueTask = async (requirePausedFlowRunId?: string): Promise<CarryOnFlowTaskResult> => {
    const outcome = withRecoveryKind(db, taskId, 'continue', () =>
      retryTaskDetailed(db, taskId, 'continue', requirePausedFlowRunId),
    );
    // Null: the row is gone, or its session no longer answered the step (rollback, newer turn).
    if (!outcome) {
      return { ok: false, reason: (await getTaskById(db, taskId)) ? 'no-session' : 'not-found' };
    }
    if (!outcome.task) {
      return { ok: false, reason: outcome.reason === 'not_found' ? 'not-found' : 'invalid-state' };
    }
    return { ok: true, task: outcome.task };
  };

  if (!existing.flowRunId) return continueTask();
  const flowRunId = existing.flowRunId;
  return withFlowResourceCleanup(flowRunId, async () => {
    const run = await getFlowRun(db, flowRunId);
    if (run?.status !== 'paused') {
      return { ok: false, reason: 'admission-required' };
    }
    const { hasActiveFlowAdmission } = await import('../admission/runtime');
    if (await hasActiveFlowAdmission(flowRunId)) return continueTask(flowRunId);
    if (!existing.nodeRunId) return { ok: false, reason: 'admission-required' };
    const { requestParkedFlowResume } = await import('../admission/terminal-resume/parked-resume');
    const admission = await requestParkedFlowResume({
      flowRunId,
      nodeRunId: existing.nodeRunId,
      kind: 'continue',
    });
    // Only a resume still waiting for a slot is queued; one already running has resumed the step.
    const outcome = admission.state === 'queued' ? recoverOutcomeFor(admission) : 'resumed';
    return { ok: true, task: existing, outcome };
  });
}
