/**
 * Carry on — resume a failed attempt's persisted Claude session IN PLACE (same worktree/chat, a short
 * continuation nudge instead of a full re-prompt), rather than re-running the step from scratch. The
 * single source of truth for Carry-on, driving the chat retry mutation (`tasks.retry mode=continue`)
 * for both standalone flows and batch members. See docs/decisions/flow-run-restart-recovery.md.
 */

import type { getDatabase } from '../../db';
import { getFlowRun } from '../../db/repos/flow-runs';
import { getSubChatById } from '../../db/repos/sub-chats';
import { getTaskById, parseResultRecord, retryTaskDetailed } from '../../db/repos/tasks';
import type { Task } from '../../db/schema';
import { withFlowResourceCleanup } from '../admission/activity';

type Db = ReturnType<typeof getDatabase>;

export type CarryOnFlowTaskResult =
  | { ok: true; task: Task }
  | {
      ok: false;
      reason: 'not-found' | 'no-session' | 'invalid-state' | 'admission-required';
    };

/**
 * Carry on ONE failed/parked task: resume its persisted Claude session (the poller re-claims the
 * pending task → the executor resumes + sends the hidden-wake continuation nudge headlessly).
 *
 *  1. Session gate — the session id is persisted at stream start, so its absence means the attempt
 *     died before the CLI produced a frame; there is nothing to continue and a silent full re-prompt
 *     would only masquerade as a resume. Fail `no-session` (Retry is the honest action there).
 *  2. Admission — a paused Flow (batch member or not) may continue only while its original
 *     activation remains active; a paused run never released its lease, so the same probe applies.
 *  3. Flip the task to pending + retryMode=continue so the poller drives the resume.
 */
export async function carryOnFlowTask(db: Db, taskId: string): Promise<CarryOnFlowTaskResult> {
  const existing = await getTaskById(db, taskId);
  if (!existing) return { ok: false, reason: 'not-found' };

  // Reject stale UI actions before looking up their persisted session or touching retry state.
  if (existing.status !== 'failed' && existing.status !== 'needs_attention') {
    return { ok: false, reason: 'invalid-state' };
  }

  const continueTask = async (requirePausedFlowRunId?: string): Promise<CarryOnFlowTaskResult> => {
    const prior = parseResultRecord(existing.result);
    const subChatId = typeof prior.subChatId === 'string' ? prior.subChatId : null;
    const subChat = subChatId ? await getSubChatById(db, subChatId) : null;
    if (!subChat?.sessionId) return { ok: false, reason: 'no-session' };

    const { task, reason } = await retryTaskDetailed(
      db,
      taskId,
      'continue',
      requirePausedFlowRunId,
    );
    if (!task) {
      return { ok: false, reason: reason === 'not_found' ? 'not-found' : 'invalid-state' };
    }
    return { ok: true, task };
  };

  if (!existing.flowRunId) return continueTask();
  const flowRunId = existing.flowRunId;
  return withFlowResourceCleanup(flowRunId, async () => {
    const run = await getFlowRun(db, flowRunId);
    if (run?.status !== 'paused') {
      return { ok: false, reason: 'admission-required' };
    }
    const { hasActiveFlowAdmission } = await import('../admission/runtime');
    if (!(await hasActiveFlowAdmission(flowRunId))) {
      return { ok: false, reason: 'admission-required' };
    }
    return continueTask(flowRunId);
  });
}
