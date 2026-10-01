/**
 * resumeFlowRun — handles `approve` / `retry` / `skip` from the renderer when
 * a run is paused on an awaiting_input / blocked / failed node.
 *
 * - approve: the paused node transitions to `completed` with empty outputs;
 *   engine walks to the next node.
 * - retry: the node is re-dispatched with the same config (new attempt).
 * - skip: the paused node transitions to `skipped`; engine walks past it.
 */

import { TRPCError } from '@trpc/server';
import type { FlowResumeSnapshot } from '../../../shared/types/flow-run/resume';
import { type NodeOutput, RESUME_ACTIONABLE_NODE_STATUSES } from '../../../shared/types/flow';
import { getDatabase } from '../db';
import { getFlowRun, getLatestFlowRunForChat } from '../db/repos/flow-runs';
import {
  getNodeRun,
  listNodeRunsForFlowRun,
  nodeMatchesResumeSnapshot,
} from '../db/repos/node-runs';
import { getSubChatById } from '../db/repos/sub-chats';
import { parkFlowTaskForSubChat } from '../db/repos';
import { getLatestFlowTaskForSubChat } from '../db/repos/tasks';
import { withFlowResourceCleanup } from './admission/activity';
import { TerminalResumeAdmissionError } from './admission/terminal-resume/resume-store';
import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import { findNodeById } from './graph';
import { lastUnfinishedNodeRun } from './rerun/resume-point';
import { commitUnpark } from './rerun/unpark-node-run';
import {
  isRestartInterrupted,
  type ReopenDeclined,
  reopenPausedRunCommand,
  restartMarkedNode,
  setFencedRunStatus,
  unparkFailedRunCommand,
} from './transitions';

export type ResumeAction = 'approve' | 'retry' | 'skip';

const USER_CANCELLED_RUN =
  'Run was cancelled by the user, not interrupted — start a fresh run instead.';

/**
 * True when a flow run is `cancelled` BUT recoverable — interrupted by a restart/reload (carries the
 * marker), not deliberately cancelled by the user. Drives the in-chat banner's "Resume flow" CTA.
 */
export async function isRunRestartInterrupted(flowRunId: string): Promise<boolean> {
  return isRestartInterrupted(getDatabase(), flowRunId);
}

/** `queued`: a resume ticket already owns the run's continuation and is waiting for a slot. */
export type InterruptedResumeMode = 'session' | 'redispatch' | 'queued';

/** Resume mechanism for this sub-chat: `queued` when a resume ticket owns the run; `session` with the
 * driving task's persisted session and an `active` slot; else `redispatch`, labelled "Re-run step". */
export async function resolveInterruptedResumeMode(
  flowRunId: string,
  subChatId: string,
): Promise<InterruptedResumeMode> {
  const db = getDatabase();
  const admission = await probeAdmission(flowRunId);
  // A queued/claimed resume ticket (boot carry-on, typed reply) already owns the continuation; a
  // second enqueue would be refused, so the row waits instead of offering a button that errors.
  if (admission?.queuedResume) return 'queued';
  const latestFlowTask = await getLatestFlowTaskForSubChat(db, subChatId);
  if (latestFlowTask?.status !== 'cancelled' || latestFlowTask.flowRunId !== flowRunId) {
    return 'redispatch';
  }
  const subChat = await getSubChatById(db, subChatId);
  if (!subChat?.sessionId) return 'redispatch';
  return admission?.active ? 'session' : 'redispatch';
}

/** `null` on a probe failure (e.g. the admission store not yet ready at boot): callers degrade to
 * redispatch, the mode that re-admits from scratch and never needs the probe. */
async function probeAdmission(
  flowRunId: string,
): Promise<{ queuedResume: boolean; active: boolean } | null> {
  try {
    const { probeFlowAdmission } = await import('./admission/runtime');
    return await probeFlowAdmission(flowRunId);
  } catch {
    return null;
  }
}

/**
 * The in-chat interrupted-run row's whole state in one read: which run the chat is showing, whether
 * it is recoverable, and — when it is — which mechanism recovers it. Lives here rather than in the
 * router so the row's rules sit beside the resume paths they describe.
 *
 * `null` when the chat has no flow run, or its newest run is not terminally cancelled (an active run
 * needs no row — it resumes silently on the next message).
 */
export async function describeInterruptedRunForChat(
  chatId: string,
  subChatId: string,
): Promise<{ runId: string; resumable: boolean; resumeMode: InterruptedResumeMode } | null> {
  const run = await getLatestFlowRunForChat(getDatabase(), chatId);
  if (run?.status !== 'cancelled') return null;
  // A user-cancelled run renders no row, so the mechanism probe would be wasted work.
  if (!(await isRunRestartInterrupted(run.id))) {
    return { runId: run.id, resumable: false, resumeMode: 'redispatch' };
  }
  return {
    runId: run.id,
    resumable: true,
    resumeMode: await resolveInterruptedResumeMode(run.id, subChatId),
  };
}

/** Retry of a failed flow task: un-park its run in place so the watcher accepts the agent's next
 * `done`. Declines, writing nothing, without the run's active slot. */
export async function resumeFailedFlowInPlace(
  flowRunId: string,
  drivingTaskId?: string,
): Promise<boolean> {
  return commitUnpark(
    flowRunId,
    () => unparkFailedRunCommand(getDatabase(), flowRunId),
    drivingTaskId,
  );
}

/**
 * User Pause from the flow chat's running strip (decision flow-run-chat-surface): park the
 * driving task FIRST (CAS running→needs_attention with the user-pause marker — a late/absent
 * completion can no longer terminalize it), THEN abort the in-flight turn WITHOUT the teardown
 * reconcile (which would CAS the fresh park to cancelled). The task-completion-watcher advances
 * the park → node awaiting_input + run paused; the follow-up-resume path resumes it. `paused:
 * false` when nothing was parked: no running task on the sub-chat. A batch member pauses
 * through the same park as any other flow — parkFlowTaskForSubChat carries no batch check.
 *
 * `abortActiveExecution` is INJECTED by the caller (the flows router passes the executor's
 * pauseActiveExecutionForSubChat) so the flows layer never imports the executor — the executor
 * already reaches into flows/resume for the follow-up paths, and the boundary must stay one-way.
 */
export async function pauseFlowRunForSubChat(
  subChatId: string,
  abortActiveExecution: (subChatId: string) => boolean,
): Promise<{ paused: boolean }> {
  const parkedTaskId = await parkFlowTaskForSubChat(getDatabase(), subChatId, {
    kind: 'user-pause',
  });
  if (!parkedTaskId) return { paused: false };
  abortActiveExecution(subChatId);
  return { paused: true };
}

const REOPEN_DECLINED: Record<ReopenDeclined, string> = {
  'run-changed': 'Flow run changed while it was being resumed.',
  'node-changed': 'This Flow step has already changed.',
  'no-slot': 'This paused Flow lost its place in the run queue. Cancel it and start it again.',
};

export async function resumeFlowRun(
  flowRunId: string,
  action: ResumeAction,
  nodeRunId: string,
  expectedSnapshot?: FlowResumeSnapshot,
): Promise<void> {
  if (expectedSnapshot && action === 'retry') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Retry this step on your computer.',
    });
  }
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  if (run.status !== 'paused') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Flow run is ${run.status}; resume requires paused state.`,
    });
  }
  const nodeRun = await getNodeRun(db, nodeRunId);
  if (!nodeRun || nodeRun.flowRunId !== flowRunId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Node run not found for this flow run' });
  }
  if (expectedSnapshot && !nodeMatchesResumeSnapshot(db, nodeRunId, expectedSnapshot)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This Flow step has already changed.',
    });
  }

  // Load context BEFORE flipping status so a missing flow/version doesn't
  // leave the run stuck `running` with no dispatch in flight.
  const ctx = await loadRunContext(flowRunId);
  if (!ctx) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Flow run context unavailable; flow or version may have been deleted.',
    });
  }

  const retryNode = action === 'retry' ? findNodeById(ctx.graph.nodes, nodeRun.nodeId) : null;
  if (retryNode === undefined) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Node ${nodeRun.nodeId} no longer in graph; can't retry.`,
    });
  }
  // Another client may have advanced this node and paused at a later step while the context loaded.
  const allowed: readonly string[] =
    action === 'approve' ? ['awaiting_input'] : RESUME_ACTIONABLE_NODE_STATUSES;
  const { transitionFlowRun } = await import('./admission/runtime');
  const fence = await transitionFlowRun(() =>
    reopenPausedRunCommand(db, flowRunId, nodeRunId, allowed, expectedSnapshot),
  );
  if (typeof fence === 'string') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: REOPEN_DECLINED[fence] });
  }

  await withFlowResourceCleanup(flowRunId, async () => {
    if (retryNode) {
      const fanOutScope =
        nodeRun.parentFanOutNodeRunId && nodeRun.laneIndex !== null
          ? {
              laneIndex: nodeRun.laneIndex,
              parentFanOutNodeRunId: nodeRun.parentFanOutNodeRunId,
            }
          : undefined;
      await dispatchAndAdvance(fence, retryNode, undefined, ctx, undefined, fanOutScope);
      return;
    }

    const synthetic: NodeOutput = {
      status: action === 'skip' ? 'skipped' : 'completed',
      outputs: action === 'approve' ? { approved: true } : {},
      artifacts: [],
      durationMs: 0,
    };
    const advanced = await advanceFlowRun(
      flowRunId,
      nodeRunId,
      synthetic,
      undefined,
      expectedSnapshot,
    );
    if (advanced === false) {
      setFencedRunStatus(db, fence, 'paused', {}, ['running']);
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This Flow step has already changed.',
      });
    }
  });
}

export async function rerunFlowRunFromInterruption(flowRunId: string): Promise<void> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  if (run.status !== 'cancelled') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Flow run is ${run.status}; re-run requires an interrupted (cancelled) run.`,
    });
  }

  // Resume point = the last node_run that did not finish successfully (the interrupted node),
  // gated on the restart marker. Shared with the in-place + banner paths so all three agree.
  const interrupted = restartMarkedNode(db, flowRunId);
  if (!interrupted) {
    const message = lastUnfinishedNodeRun(await listNodeRunsForFlowRun(db, flowRunId))
      ? USER_CANCELLED_RUN
      : 'No interrupted node to re-run.';
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }

  const { requestTerminalFlowResume } = await import('./admission/runtime');
  // Re-read in the enqueue transaction, so a Work Queue Cancel that clears the marker first wins.
  const admit = (tx: typeof db) => isRestartInterrupted(tx, flowRunId);
  await requestTerminalFlowResume({ flowRunId, nodeRunId: interrupted.id, admit }).catch(
    (error) => {
      // A Cancel that cleared the marker, before the enqueue or while it drained, is the user's call.
      if (!(error instanceof TerminalResumeAdmissionError) || isRestartInterrupted(db, flowRunId))
        throw error;
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: USER_CANCELLED_RUN,
        cause: error,
      });
    },
  );
}
