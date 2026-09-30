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
import {
  type NodeOutput,
  RESTART_INTERRUPTION_REASON,
  RESUME_ACTIONABLE_NODE_STATUSES,
} from '../../../shared/types/flow';
import { getDatabase } from '../db';
import { getFlowRun, getLatestFlowRunForChat, setFlowRunStatus } from '../db/repos/flow-runs';
import {
  getNodeRun,
  listNodeRunsForFlowRun,
  nodeMatchesResumeSnapshot,
} from '../db/repos/node-runs';
import { getSubChatById } from '../db/repos/sub-chats';
import { parkFlowTaskForSubChat } from '../db/repos';
import { getLatestFlowTaskForSubChat } from '../db/repos/tasks';
import type { NodeRun } from '../db/schema';
import { withFlowResourceCleanup } from './admission/activity';
import { advanceFlowRun, dispatchAndAdvance, loadRunContext } from './advance';
import { findNodeById } from './graph';
import { lastUnfinishedNodeRun } from './rerun/resume-point';
import { type DrivingTaskRow, unparkNodeRunInPlace } from './rerun/unpark-node-run';

type Db = ReturnType<typeof getDatabase>;

export type ResumeAction = 'approve' | 'retry' | 'skip';

type InterruptedNodeLookup =
  | { ok: true; nodeRun: NodeRun }
  | { ok: false; reason: 'none' | 'user-cancel' };

async function findRestartInterruptedNode(
  db: Db,
  flowRunId: string,
): Promise<InterruptedNodeLookup> {
  const nodeRunsForRun = await listNodeRunsForFlowRun(db, flowRunId);
  const interrupted = lastUnfinishedNodeRun(nodeRunsForRun);
  if (!interrupted) return { ok: false, reason: 'none' };
  const interruptedOutput = interrupted.nodeOutput as NodeOutput | null;
  if (interruptedOutput?.error?.message !== RESTART_INTERRUPTION_REASON) {
    return { ok: false, reason: 'user-cancel' };
  }
  return { ok: true, nodeRun: interrupted };
}

/**
 * True when a flow run is `cancelled` BUT recoverable — interrupted by a restart/reload (carries the
 * marker), not deliberately cancelled by the user. Drives the in-chat banner's "Resume flow" CTA.
 */
export async function isRunRestartInterrupted(flowRunId: string): Promise<boolean> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (run?.status !== 'cancelled') return false;
  return (await findRestartInterruptedNode(db, flowRunId)).ok;
}

/** `queued`: a resume ticket already owns the run's continuation and is waiting for a slot. */
export type InterruptedResumeMode = 'session' | 'redispatch' | 'queued';

/**
 * WHICH mechanism resumes a restart-interrupted run from THIS sub-chat — the discriminator behind
 * the in-chat Resume affordance.
 *
 * `session`: the interrupted node is the agent driving this sub-chat AND its Claude session
 * persisted, so a hidden wake message revives it in place (executor `resumeTaskOnFollowUpMessage`
 * -> `resumeInterruptedFlowInPlace`) with no re-prompt. Both halves are required and neither
 * implies the other:
 *  - the cancelled+marker driving task must be this sub-chat's NEWEST flow task. This is the same
 *    gate the executor's revive keys on, deliberately reused so the two can never disagree. A
 *    non-agent interrupted node (run_command/http, swept by recoverOrphanedNodeRuns) fails it —
 *    the newest flow task here is the PRIOR node's `done`, so a message would resume nothing;
 *  - the sub-chat must carry a session id (persisted at stream start). Without one the follow-up
 *    degrades to a full history replay, which re-runs the whole step wearing a resume's clothes.
 *
 * `redispatch`: everything else falls back to `rerunFlowRunFromInterruption`, which is run-scoped
 * and covers what a chat message cannot. Callers MUST label that branch honestly ("Re-run step") —
 * it re-sends the node's instructions, which a "Resume" must never appear to do.
 *
 * `session` additionally requires the run to still hold its active admission: a session revive
 * continues the run in place without re-admitting, so without a live slot the wake turn is
 * rejected at the provider preflight and the failure park strands the run `paused` with no slot —
 * a state no affordance or sweep recovers. This is a runtime check, not a constant `redispatch`,
 * because a cancelled run can briefly retain its `active` ticket while another in-process activity
 * owner holds it (settleTerminalAdmission defers while activity is live); in that window a session
 * revive is still legitimate. `redispatch` re-admits via a durable resume ticket instead.
 */
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

/**
 * Read-only eligibility probe for the in-place revive: run `cancelled`, restart marker present,
 * admission slot still active. The caller MUST probe before flipping its driving task and only
 * then unpark — that ordering is load-bearing twice over: a failed probe leaves the task
 * `cancelled` (so the failure park's `running` CAS can never strand the run paused-without-slot,
 * and re-dispatch recovery stays available), while a passed probe flips the task to `running`
 * BEFORE the run/node go live, so the completion watcher's terminal-status query structurally
 * cannot re-select the task mid-revive — its in-memory advanced-set is not restart-durable, and
 * a second crash inside that window would otherwise let the first tick re-advance the stale
 * cancelled output and re-cancel the just-unparked run. The caller must also hold a
 * flow-resource activity reservation (withFlowResourceCleanup) across probe→writes: settlement
 * defers while activity is held, so the slot this probe sees cannot settle mid-window.
 */
export async function canReviveInterruptedFlowInPlace(flowRunId: string): Promise<boolean> {
  const db = getDatabase();
  if ((await getFlowRun(db, flowRunId))?.status !== 'cancelled') return false;
  const { hasActiveFlowAdmission } = await import('./admission/runtime');
  if (!(await hasActiveFlowAdmission(flowRunId))) return false;
  return (await findRestartInterruptedNode(db, flowRunId)).ok;
}

/**
 * Unpark a restart-interrupted (`cancelled` + marker) run IN PLACE for a chat follow-up message —
 * the sibling of `resumeFlowNodeInPlace` for the cancelled case. The agent process died with the
 * restart, but the executor's follow-up turn (which calls this) IS the continuation: we only flip
 * the interrupted node_run + flow_run back to `running` and clear the marker so the watcher accepts
 * the agent's next `done` and advances. We do NOT re-dispatch (that is `rerunFlowRunFromInterruption`,
 * the banner-button path) — re-dispatching here would double-run alongside the executor's turn.
 * Returns false (no-op) when the run isn't a recoverable interruption.
 */
export async function resumeInterruptedFlowInPlace(flowRunId: string): Promise<boolean> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (run?.status !== 'cancelled') return false;
  // A wake continues the run in place WITHOUT re-admitting, so it is only legal while the run
  // still holds its active admission — possible for a cancelled run only in the activity-held
  // window before the slot settles. Otherwise decline (false): the caller flips nothing, and the
  // re-dispatch path — which re-admits via a durable resume ticket — stays available.
  const { hasActiveFlowAdmission } = await import('./admission/runtime');
  if (!(await hasActiveFlowAdmission(flowRunId))) return false;
  const lookup = await findRestartInterruptedNode(db, flowRunId);
  if (!lookup.ok) return false;
  // CAS on `cancelled`: if a concurrent path already re-advanced the node, this matches 0 rows and
  // no-ops instead of clobbering a real nodeOutput/completedAt back to running.
  return unparkNodeRunInPlace(db, flowRunId, lookup.nodeRun.id, undefined, ['cancelled'], {
    fromRunStatuses: ['running', 'cancelled'],
    prior: lookup.nodeRun,
  });
}

export async function resumeFailedFlowInPlace(
  flowRunId: string,
  drivingTaskId?: string,
): Promise<boolean> {
  // The reservation makes the admission probe below check-then-act safe: settlement defers while
  // activity is held, so the slot the probe sees cannot settle before the unpark's writes land.
  return withFlowResourceCleanup(flowRunId, () => unparkFailedFlowRun(flowRunId, drivingTaskId));
}

async function unparkFailedFlowRun(flowRunId: string, drivingTaskId?: string): Promise<boolean> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) return false;
  if (run.batchId != null && !(await batchMemberUnparkAllowed(db, flowRunId))) return false;
  // Same lease rule as every in-place unpark: continuing WITHOUT re-admitting is only legal while
  // the run still holds its slot. A paused run keeps it (no behavior change); a terminal
  // failed/cancelled run's slot is settled, and flipping it live anyway would get the turn
  // rejected at the provider preflight and the failure park would strand the run
  // paused-without-slot. Declining leaves the run terminal, where Retry re-admits properly.
  const { hasActiveFlowAdmission } = await import('./admission/runtime');
  if (!(await hasActiveFlowAdmission(flowRunId))) return false;
  // `cancelled` is included ONLY for the boot-sweep race (the task failed, then a restart sweep
  // flipped its run to cancelled before the user clicked Retry) — gated on the same restart
  // marker every other resume path uses. A DELIBERATE user-cancel carries no marker and must not
  // be resurrected by retrying an older failed task of that run.
  if (run.status === 'cancelled') {
    const lookup = await findRestartInterruptedNode(db, flowRunId);
    if (!lookup.ok) return false;
    return unparkNodeRunInPlace(db, flowRunId, lookup.nodeRun.id, drivingTaskId, ['cancelled'], {
      fromRunStatuses: ['running', 'cancelled'],
      prior: lookup.nodeRun,
    });
  }
  if (run.status !== 'failed' && run.status !== 'paused') return false;
  return unparkLastUnfinishedNode(db, flowRunId, drivingTaskId);
}

/** The one batch-only gate left on in-place revival: a stage that already settled on this member no longer
 * waits for its `done`, so reviving it in place is refused — Retry (admission-gated) is the recovery. */
async function batchMemberUnparkAllowed(db: Db, flowRunId: string): Promise<boolean> {
  const { getStageRunByFlowRunId } = await import('../db/repos/batch-stage-runs');
  return (await getStageRunByFlowRunId(db, flowRunId))?.status === 'dispatched';
}

async function unparkLastUnfinishedNode(
  db: Db,
  flowRunId: string,
  drivingTaskId?: string,
): Promise<boolean> {
  const nodeRun = lastUnfinishedNodeRun(await listNodeRunsForFlowRun(db, flowRunId));
  if (!nodeRun) return false;
  return unparkNodeRunInPlace(
    db,
    flowRunId,
    nodeRun.id,
    drivingTaskId,
    ['failed', 'awaiting_input', 'blocked'],
    { fromRunStatuses: ['running', 'paused', 'failed'], prior: nodeRun },
  );
}

export async function resumeFlowNodeInPlace(
  flowRunId: string,
  nodeRunId: string,
  drivingTaskId?: string,
  drivingTaskRow?: DrivingTaskRow,
): Promise<boolean> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (run?.status !== 'paused') return false;

  const nodeRun = await getNodeRun(db, nodeRunId);
  if (!nodeRun || nodeRun.flowRunId !== flowRunId) return false;
  return unparkNodeRunInPlace(
    db,
    flowRunId,
    nodeRunId,
    drivingTaskId,
    ['awaiting_input', 'blocked'],
    {
      fromRunStatuses: ['running', 'paused'],
      drivingTaskRow,
      prior: nodeRun,
    },
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

  // Reason: Resume validation and recovery stay together under the Flow cleanup boundary.
  // fallow-ignore-next-line complexity
  await withFlowResourceCleanup(flowRunId, async () => {
    const resumed = await setFlowRunStatus(db, flowRunId, 'running', {}, 'paused');
    if (!resumed) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Flow run changed while it was being resumed.',
      });
    }
    // A different client may have advanced this node and paused at a later step while the
    // context was loading. The run CAS alone cannot distinguish those two pauses.
    const currentNode = await getNodeRun(db, nodeRunId);
    const allowed: readonly string[] =
      action === 'approve' ? ['awaiting_input'] : RESUME_ACTIONABLE_NODE_STATUSES;
    if (
      !currentNode ||
      !allowed.includes(currentNode.status) ||
      (expectedSnapshot && !nodeMatchesResumeSnapshot(db, nodeRunId, expectedSnapshot))
    ) {
      await setFlowRunStatus(db, flowRunId, 'paused', {}, 'running');
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This Flow step has already changed.',
      });
    }
    const { hasActiveFlowAdmission } = await import('./admission/runtime');
    if (!(await hasActiveFlowAdmission(flowRunId))) {
      await setFlowRunStatus(db, flowRunId, 'paused', {}, 'running');
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This paused Flow lost its place in the run queue. Cancel it and start it again.',
      });
    }

    if ((await getFlowRun(db, flowRunId))?.status !== 'running') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Flow run changed while it was being resumed.',
      });
    }
    if (action === 'retry') {
      const node = findNodeById(ctx.graph.nodes, nodeRun.nodeId);
      if (!node) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Node ${nodeRun.nodeId} no longer in graph; can't retry.`,
        });
      }
      const fanOutScope =
        nodeRun.parentFanOutNodeRunId && nodeRun.laneIndex !== null
          ? {
              laneIndex: nodeRun.laneIndex,
              parentFanOutNodeRunId: nodeRun.parentFanOutNodeRunId,
            }
          : undefined;
      await dispatchAndAdvance(flowRunId, node, undefined, ctx, undefined, fanOutScope);
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
      await setFlowRunStatus(db, flowRunId, 'paused', {}, 'running');
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
  const lookup = await findRestartInterruptedNode(db, flowRunId);
  if (!lookup.ok) {
    const message =
      lookup.reason === 'none'
        ? 'No interrupted node to re-run.'
        : 'Run was cancelled by the user, not interrupted — start a fresh run instead.';
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }
  const interrupted = lookup.nodeRun;

  const { requestTerminalFlowResume } = await import('./admission/runtime');
  await requestTerminalFlowResume({ flowRunId, nodeRunId: interrupted.id });
}
