import { getDatabase } from '../../../db';
import { listNodeRunsForFlowRun } from '../../../db/repos/node-runs';
import { dispatchAndAdvance, loadRunContext } from '../../advance';
import type { NodeOutput } from '../../../../../shared/types/flow';
import { emitRunStarted } from '../../event-emit';
import { loadOwningFanOutState } from '../../fan-out-step';
import { findNodeById } from '../../graph';
import {
  type SiblingBranchResumeTarget,
  siblingBranchResumeTargets,
} from '../../rerun/fan-out-lane-resume';
import { reconstructPreviousOutput } from '../../rerun/predecessor-output';
import { lastUnfinishedNodeRun, resolveRerunStartNode } from '../../rerun/resume-point';
import { type RunFence, readRunFence } from '../../transitions';
import { registerTerminalFlowResumeDispatcher, requestTerminalFlowResume } from '../runtime';
import type { TerminalFlowResumeIntent } from './resume-store';

type Db = ReturnType<typeof getDatabase>;
type RunContext = NonNullable<Awaited<ReturnType<typeof loadRunContext>>>;

type TerminalResumeTarget = {
  ctx: RunContext;
  node: RunContext['graph']['nodes'][number];
  nodeRunId: string;
  /** What the anchor was first dispatched with, so {{previous.*}} resolves on the resume. */
  previousOutput?: NodeOutput;
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
  const fanOutState = fanOutScope
    ? await loadOwningFanOutState(ctx.meta.flowId, flowRunId, node)
    : undefined;
  const previousOutput = reconstructPreviousOutput({
    graph: ctx.graph,
    nodeRuns: attempts,
    nodeId,
    scope: fanOutScope,
    beforeNodeRunId: anchor.id,
    fanOutState,
  });
  const siblings = fanOutScope
    ? siblingBranchResumeTargets(ctx.graph, attempts, anchor, fanOutState)
    : [];
  return { ctx, node, nodeRunId: anchor.id, previousOutput, fanOutScope, siblings };
}

export async function retryTerminalFlowRun(db: Db, flowRunId: string): Promise<boolean> {
  const target = await resolveTerminalResumeTarget(db, flowRunId);
  if (!target) return false;
  // User Retry is continuation-first: a surviving session is continued instead of
  // re-instructed. The deliberate re-run surfaces (flows.rerunRun) omit the flag.
  await requestTerminalFlowResume({ flowRunId, nodeRunId: target.nodeRunId, continuation: true });
  return true;
}

/** Re-dispatch the anchor and, inside a Fan Out item, every sibling branch it must finish beside.
 * Only the anchor continues its session; siblings were swept mid-step and are re-instructed. */
export async function dispatchTerminalResumeTarget(
  fence: RunFence,
  target: TerminalResumeTarget,
  continuation: boolean,
): Promise<void> {
  // allSettled: the caller settles the ticket once this returns, so no branch may still be advancing.
  const results = await Promise.allSettled([
    dispatchAndAdvance(fence, target.node, target.previousOutput, target.ctx, undefined, {
      resumeKind: continuation ? 'continuation' : 'redispatch',
      ...target.fanOutScope,
    }),
    ...target.siblings.map((sibling) =>
      dispatchAndAdvance(fence, sibling.node, sibling.previousOutput, target.ctx, undefined, {
        resumeKind: 'redispatch',
        ...target.fanOutScope,
      }),
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
  await dispatchTerminalResumeTarget(fence, target, intent.continuation === true);
}

registerTerminalFlowResumeDispatcher(dispatchAdmittedTerminalResume);
