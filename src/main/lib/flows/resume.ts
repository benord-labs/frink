/**
 * resumeFlowRun — handles `approve` / `retry` / `skip` from the renderer when
 * a run is paused on an awaiting_input / blocked / failed node.
 *
 * - approve: the paused node transitions to `completed` with empty outputs;
 *   engine walks to the next node.
 * - retry: the node is re-dispatched with the same config (new attempt), continuing its agent
 *   session when the click was Continue (its session already answered the step).
 * - skip: the paused node transitions to `skipped`; engine walks past it.
 */

import { TRPCError } from '@trpc/server';
import type { FlowResumeSnapshot, RecoveryKind } from '../../../shared/types/flow-run/resume';
import { type NodeOutput, RESUME_ACTIONABLE_NODE_STATUSES } from '../../../shared/types/flow';
import { getDatabase } from '../db';
import { getFlowRun, getLatestFlowRunForChat } from '../db/repos/flow-runs';
import {
  getNodeRun,
  listNodeRunsForFlowRun,
  nodeMatchesResumeSnapshot,
} from '../db/repos/node-runs';
import { parkFlowTaskForSubChat } from '../db/repos';
import { withFlowResourceCleanup } from './admission/activity';
import { hasStagedContinuation } from './admission/terminal-resume/continuation';
import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import { findNodeById } from './graph';
import { recoveryChangedError, stepRecoveryKind } from './rerun/recovery-kind';
import { lastUnfinishedNodeRun } from './rerun/resume-point';
import { commitUnpark } from './rerun/unpark-node-run';
import {
  isRestartInterrupted,
  type ReopenDeclined,
  reopenPausedRunCommand,
  type RunFence,
  setFencedRunStatus,
  unparkFailedRunCommand,
} from './transitions';

export type ResumeAction = 'approve' | 'retry' | 'skip';

/**
 * True when a flow run is `cancelled` BUT recoverable — interrupted by a restart/reload (carries the
 * marker), not deliberately cancelled by the user. Gates the in-chat interrupted-run recovery.
 */
export async function isRunRestartInterrupted(flowRunId: string): Promise<boolean> {
  return isRestartInterrupted(getDatabase(), flowRunId);
}

/** How the in-chat interrupted-run row recovers, always through a resume ticket; `queued` while a
 * continuation already owns the run. */
type InterruptedResumeMode = 'continue' | 'retry' | 'queued';

export type InterruptedResume = {
  resumeMode: InterruptedResumeMode;
  /** The step is not an agent and had started, so running it again may repeat its side effects. */
  confirmSideEffects: boolean;
  /** The step a recovery would act on; a confirmation is for this step only. */
  nodeRunId: string | null;
};

export async function resolveInterruptedResumeMode(flowRunId: string): Promise<InterruptedResume> {
  const db = getDatabase();
  const admission = await probeAdmission(flowRunId);
  // The resume target: the run's last unfinished step (resolveTerminalResumeTarget's anchor).
  const target = lastUnfinishedNodeRun(await listNodeRunsForFlowRun(db, flowRunId));
  const step = {
    confirmSideEffects:
      target !== undefined && target.blockType !== 'agent' && target.startedAt != null,
    nodeRunId: target?.id ?? null,
  };
  // A queued ticket, or a stage a live admission will still fire, already owns the continuation.
  if (admission?.queuedResume || (admission?.live && hasStagedContinuation(flowRunId))) {
    return { resumeMode: 'queued', ...step };
  }
  // The same rule the Retry/Continue mutations re-check, so the row never offers a refused kind.
  if (!target || stepRecoveryKind(db, target.id) === 'retry') {
    return { resumeMode: 'retry', ...step };
  }
  return { resumeMode: 'continue', ...step };
}

/** `null` on a probe failure (e.g. the admission store not yet ready at boot): callers degrade to
 * a resume ticket, which re-admits from scratch and never needs the probe. */
async function probeAdmission(
  flowRunId: string,
): Promise<{ queuedResume: boolean; live: boolean } | null> {
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
): Promise<({ runId: string; resumable: boolean } & InterruptedResume) | null> {
  const run = await getLatestFlowRunForChat(getDatabase(), chatId);
  if (run?.status !== 'cancelled') return null;
  // A user-cancelled run renders no row, so the mechanism probe would be wasted work.
  if (!(await isRunRestartInterrupted(run.id))) {
    return {
      runId: run.id,
      resumable: false,
      resumeMode: 'retry',
      confirmSideEffects: false,
      nodeRunId: null,
    };
  }
  return {
    runId: run.id,
    resumable: true,
    ...(await resolveInterruptedResumeMode(run.id)),
  };
}

/** Retry of a failed flow task: un-park its run in place so the watcher accepts the agent's next
 * `done`. Declines, writing nothing, without the run's active slot or once the run is cancelled. */
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

/**
 * Reopens the paused run. Another client may have advanced the node meanwhile; a Retry also
 * re-checks, in the same transition, that its step still recovers as the `kind` the user clicked.
 */
async function reopenForResume(
  flowRunId: string,
  nodeRunId: string,
  action: ResumeAction,
  expectedSnapshot: FlowResumeSnapshot | undefined,
  kind: RecoveryKind | undefined,
): Promise<RunFence> {
  const db = getDatabase();
  const allowed: readonly string[] =
    action === 'approve' ? ['awaiting_input'] : RESUME_ACTIONABLE_NODE_STATUSES;
  const { transitionFlowRun } = await import('./admission/runtime');
  const fence = await transitionFlowRun(() =>
    action === 'retry' && stepRecoveryKind(db, nodeRunId) !== kind
      ? 'kind-changed'
      : reopenPausedRunCommand(db, flowRunId, nodeRunId, allowed, expectedSnapshot),
  );
  if (fence === 'kind-changed') throw recoveryChangedError();
  if (typeof fence === 'string') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: REOPEN_DECLINED[fence] });
  }
  return fence;
}

/** `kind` is the recovery a Retry click showed; a step that no longer recovers that way is refused. */
export async function resumeFlowRun(
  flowRunId: string,
  action: ResumeAction,
  nodeRunId: string,
  expectedSnapshot?: FlowResumeSnapshot,
  kind?: RecoveryKind,
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
  const fence = await reopenForResume(flowRunId, nodeRunId, action, expectedSnapshot, kind);

  await withFlowResourceCleanup(flowRunId, async () => {
    if (retryNode) {
      const fanOutScope =
        nodeRun.parentFanOutNodeRunId && nodeRun.laneIndex !== null
          ? {
              laneIndex: nodeRun.laneIndex,
              parentFanOutNodeRunId: nodeRun.parentFanOutNodeRunId,
            }
          : undefined;
      // Either kind is a new attempt: the paused row goes `superseded` in the insert's own tick.
      // Continue picks the answering session up where it stopped; Retry re-sends the instructions.
      await dispatchAndAdvance(fence, retryNode, undefined, ctx, undefined, {
        ...fanOutScope,
        supersedesNodeRunId: nodeRunId,
        resumeKind: kind === 'continue' ? 'continuation' : undefined,
      });
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
