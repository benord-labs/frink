import { getDatabase } from '../../../db';
import { getFlowRun } from '../../../db/repos/flow-runs';
import { listNodeRunsForFlowRun } from '../../../db/repos/node-runs';
import { dispatchAndAdvance, loadRunContext } from '../../advance';
import { reserveNodeAbortRegistration } from '../../cancel-registry';
import { emitRunStarted } from '../../event-emit';
import { findNodeById } from '../../graph';
import { lastUnfinishedNodeRun, resolveRerunStartNode } from '../../rerun/resume-point';
import { registerTerminalFlowResumeDispatcher, requestTerminalFlowResume } from '../runtime';
import type { TerminalFlowResumeIntent } from './resume-store';

type Db = ReturnType<typeof getDatabase>;
type RunContext = NonNullable<Awaited<ReturnType<typeof loadRunContext>>>;

type TerminalResumeTarget = {
  ctx: RunContext;
  node: RunContext['graph']['nodes'][number];
  nodeRunId: string;
  fanOutScope?: {
    laneIndex: number;
    parentFanOutNodeRunId: string;
  };
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
  return { ctx, node, nodeRunId: anchor.id, fanOutScope };
}

export async function retryTerminalFlowRun(db: Db, flowRunId: string): Promise<boolean> {
  const target = await resolveTerminalResumeTarget(db, flowRunId);
  if (!target) return false;
  // User Retry is continuation-first: a surviving session is continued instead of
  // re-instructed. The deliberate re-run surfaces (flows.rerunRun) omit the flag.
  await requestTerminalFlowResume({ flowRunId, nodeRunId: target.nodeRunId, continuation: true });
  return true;
}

async function dispatchAdmittedTerminalResume(intent: TerminalFlowResumeIntent): Promise<void> {
  const db = getDatabase();
  const target = await resolveTerminalResumeTarget(db, intent.flow_run_id);
  if (!target) {
    throw new Error(`Flow run ${intent.flow_run_id} has no canonical resume target`);
  }
  if (target.nodeRunId !== intent.node_run_id) {
    throw new Error(`Flow run ${intent.flow_run_id} changed its canonical resume target`);
  }
  const releaseRegistration = reserveNodeAbortRegistration(intent.flow_run_id);
  if (!releaseRegistration) throw new Error(`Flow run ${intent.flow_run_id} is being cancelled`);
  try {
    const run = await getFlowRun(db, intent.flow_run_id);
    if (run?.status !== 'running') {
      throw new Error(`Flow run ${intent.flow_run_id} is no longer dispatchable`);
    }
    emitRunStarted(target.ctx.meta, intent.flow_run_id);
    await dispatchAndAdvance(
      intent.flow_run_id,
      target.node,
      undefined,
      target.ctx,
      undefined,
      releaseRegistration,
      {
        resumeKind: intent.continuation ? 'continuation' : 'redispatch',
        ...target.fanOutScope,
      },
    );
  } finally {
    releaseRegistration();
  }
}

registerTerminalFlowResumeDispatcher(dispatchAdmittedTerminalResume);
