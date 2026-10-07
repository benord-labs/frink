import { TRPCError } from '@trpc/server';
import type { RecoveryKind } from '../../../../../shared/types/flow-run/resume';
import { getDatabase } from '../../../db';
import { listNodeRunsForFlowRun } from '../../../db/repos/node-runs';
import { dispatchAndAdvance, loadRunContext } from '../../advance';
import { emitRunStarted } from '../../event-emit';
import { findNodeById } from '../../graph';
import {
  type SiblingBranchResumeTarget,
  siblingBranchResumeTargets,
} from '../../rerun/fan-out-lane-resume';
import { recoveryChangedError, stepRecoveryKind } from '../../rerun/recovery-kind';
import { lastUnfinishedNodeRun, resolveRerunStartNode } from '../../rerun/resume-point';
import { isUserCancelled, type RunFence, readNodeRuns, readRunFence } from '../../transitions';
import { registerTerminalFlowResumeDispatcher, requestTerminalFlowResume } from '../runtime';
import {
  registerResumeTargetRefusal,
  type TerminalFlowResumeIntent,
  TerminalResumeAdmissionError,
} from './resume-store';

type Db = ReturnType<typeof getDatabase>;
type RunContext = NonNullable<Awaited<ReturnType<typeof loadRunContext>>>;

type TerminalResumeTarget = {
  ctx: RunContext;
  node: RunContext['graph']['nodes'][number];
  nodeRunId: string;
  /** The anchor's session answered its prompt, so the resume continues it instead of re-running. */
  continues: boolean;
  fanOutScope?: {
    laneIndex: number;
    parentFanOutNodeRunId: string;
  };
  /** The other branches of the anchor's Fan Out item, re-dispatched with it so the barrier can close. */
  siblings: SiblingBranchResumeTarget[];
};

/**
 * The canonical resume target for a terminal run. Exported for the typed-reply
 * decline-and-convert preflight (socket/execution/flow-resource-cleanup.ts), which must
 * gate on the same anchor this dispatcher will re-resolve at claim time.
 */
export async function resolveTerminalResumeTarget(
  db: Db,
  flowRunId: string,
): Promise<TerminalResumeTarget | null> {
  const ctx = await loadRunContext(flowRunId);
  if (!ctx) return null;
  const attempts = await listNodeRunsForFlowRun(db, flowRunId);
  const unfinished = lastUnfinishedNodeRun(attempts);
  const nodeId = unfinished?.nodeId ?? resolveRerunStartNode(ctx.graph, attempts);
  if (!nodeId) return null;
  const node = findNodeById(ctx.graph.nodes, nodeId);
  const anchor = unfinished ?? [...attempts].reverse().find((attempt) => attempt.nodeId === nodeId);
  if (!node || !anchor) return null;
  const fanOutScope =
    anchor.laneIndex !== null && anchor.parentFanOutNodeRunId
      ? {
          laneIndex: anchor.laneIndex,
          parentFanOutNodeRunId: anchor.parentFanOutNodeRunId,
        }
      : undefined;
  const siblings = fanOutScope ? siblingBranchResumeTargets(ctx.graph, attempts, anchor) : [];
  const continues = stepRecoveryKind(db, anchor.id) === 'continue';
  return { ctx, node, nodeRunId: anchor.id, continues, fanOutScope, siblings };
}

const USER_CANCELLED_RUN =
  'Run was cancelled by the user, not interrupted — start a fresh run instead.';

const userCancelledRun = (cause?: unknown) =>
  new TRPCError({ code: 'PRECONDITION_FAILED', message: USER_CANCELLED_RUN, cause });

/**
 * Re-admit a settled run from its resume target. The enqueue transaction refuses a run the user
 * cancelled, or whose step no longer recovers as `kind`. False when its flow or version is gone.
 */
export async function retryTerminalFlowRun(
  db: Db,
  flowRunId: string,
  kind: RecoveryKind,
): Promise<boolean> {
  if (isUserCancelled(db, flowRunId)) throw userCancelledRun();
  const target = await resolveTerminalResumeTarget(db, flowRunId);
  if (!target) return false;
  const admit = (tx: Db) => {
    if (stepRecoveryKind(tx, target.nodeRunId) !== kind) throw recoveryChangedError();
    return !isUserCancelled(tx, flowRunId);
  };
  await requestTerminalFlowResume({ flowRunId, nodeRunId: target.nodeRunId, kind, admit }).catch(
    (error) => {
      const cancelledMeanwhile =
        error instanceof TerminalResumeAdmissionError && isUserCancelled(db, flowRunId);
      throw cancelledMeanwhile ? userCancelledRun(error) : error;
    },
  );
  return true;
}

/** Re-dispatch the anchor and, inside a Fan Out item, every sibling branch it must finish beside.
 * The anchor continues only as its label promised; each sibling's own session decides for it. */
export async function dispatchTerminalResumeTarget(
  fence: RunFence,
  target: TerminalResumeTarget,
): Promise<void> {
  const siblingOptions = { resumeKind: 'continuation' as const, ...target.fanOutScope };
  const anchorOptions = {
    ...siblingOptions,
    resumeKind: target.continues ? siblingOptions.resumeKind : undefined,
  };
  // allSettled: the caller settles the ticket once this returns, so no branch may still be advancing.
  const results = await Promise.allSettled([
    dispatchAndAdvance(fence, target.node, undefined, target.ctx, undefined, anchorOptions),
    ...target.siblings.map((sibling) =>
      dispatchAndAdvance(
        fence,
        sibling.node,
        sibling.previousOutput,
        target.ctx,
        undefined,
        siblingOptions,
      ),
    ),
  ]);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

async function dispatchAdmittedTerminalResume(
  intent: TerminalFlowResumeIntent,
  ticket: number,
): Promise<void> {
  const db = getDatabase();
  const target = await resolveTerminalResumeTarget(db, intent.flow_run_id);
  if (!target) {
    throw new Error(`Flow run ${intent.flow_run_id} has no canonical resume target`);
  }
  if (target.nodeRunId !== intent.node_run_id) {
    throw new Error(`Flow run ${intent.flow_run_id} changed its canonical resume target`);
  }
  // A Cancel that committed after promotion owns the run; its release settles this ticket.
  const fence = readRunFence(db, intent.flow_run_id, ticket);
  if (!fence) return;
  emitRunStarted(target.ctx.meta, intent.flow_run_id);
  await dispatchTerminalResumeTarget(fence, target);
}

registerTerminalFlowResumeDispatcher(dispatchAdmittedTerminalResume);
/** Whether `intent` still names the anchor resolveTerminalResumeTarget picks; synchronous, so the
 * claim's transaction reads it. An intent was an anchor, so its node is the fallback start node. */
function isCanonicalResumeTarget(db: Db, intent: TerminalFlowResumeIntent): boolean {
  const attempts = readNodeRuns(db, intent.flow_run_id);
  const nodeId = attempts.find((attempt) => attempt.id === intent.node_run_id)?.nodeId;
  const anchor =
    lastUnfinishedNodeRun(attempts) ?? attempts.findLast((attempt) => attempt.nodeId === nodeId);
  return anchor?.id === intent.node_run_id;
}

registerResumeTargetRefusal((db, intent) => {
  const kind = intent.recovery_kind;
  const changed = kind !== undefined && stepRecoveryKind(db, intent.node_run_id) !== kind;
  return changed || !isCanonicalResumeTarget(db, intent) ? recoveryChangedError().message : null;
});
