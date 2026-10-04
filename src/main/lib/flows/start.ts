/**
 * startFlowRun — replaces the Phase 2 skeleton's immediate-fail behaviour with
 * real execution. Picks the trigger node from the latest version's graph,
 * inserts the first node_run, dispatches, recurses via advanceFlowRun.
 */

import { TRPCError } from '@trpc/server';
import { isTriggerBlockType } from '../../../shared/lib/block-registry';
import { getDatabase } from '../db';
import { getLatestVersion, getVersion } from '../db/repos/flow-versions';
import { getFlowById } from '../db/repos/flows';
import type { FlowRun, FlowVersion } from '../db/schema';
import { registerFlowAdmissionStartDispatcher, requestFlowStart } from './admission/runtime';
import { dispatchAndAdvance, loadRunContext } from './advance';
import { emitRunStarted } from './event-emit';
import { findNodeById, parseGraph } from './graph';
import { type RunFence, readRunFence } from './transitions';

type Db = ReturnType<typeof getDatabase>;

export type StartFlowRunInput = {
  flowId: string;
  triggerContext?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  /** Pin a specific version (batch dispatch) instead of resolving the latest. */
  flowVersionId?: string | null;
  /** Tag the run as part of a batch (flow_runs.batch_id). */
  batchId?: string | null;
  /** Atomically move this eligible batch member from pending into global admission. */
  batchStageRunId?: string | null;
  /** The stage that member was read from; admission leaves a member moved since for its new stage. */
  batchStageId?: string | null;
};

async function loadStartDefinition(db: Db, input: StartFlowRunInput) {
  const flow = await getFlowById(db, input.flowId);
  if (!flow) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
  if (!flow.isEnabled) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Flow is disabled' });
  }

  const version = input.flowVersionId
    ? await getVersion(db, input.flowVersionId)
    : await getLatestVersion(db, input.flowId);
  if (!version) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: input.flowVersionId
        ? 'Pinned flow version not found.'
        : 'Flow has no saved version — save a version before running.',
    });
  }

  const graph = parseGraph(version.graph);
  // The trigger is the flow's single entry node, identified by BLOCK TYPE — not by
  // array position. Graphs from the MCP patch builder / imports may not place the
  // trigger at nodes[0], and the matcher (extractFlowWebhookBindingFromGraph) finds
  // it at any index; dispatching from nodes[0] instead would throw and silently
  // no-fire the flow.
  const trigger = graph.nodes.find((node) => isTriggerBlockType(node.blockType));
  if (!trigger) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Flow graph has no trigger node',
    });
  }
  return { flow, version, trigger };
}

export async function startFlowRun(input: StartFlowRunInput): Promise<{
  run: FlowRun;
  version: FlowVersion;
  isReplay: boolean;
}> {
  const db = getDatabase();
  const { version } = await loadStartDefinition(db, input);
  const result = await requestFlowStart({
    flowVersionId: version.id,
    triggerContext: input.triggerContext ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    batchId: input.batchId ?? null,
    batchStageRunId: input.batchStageRunId ?? null,
    batchStageId: input.batchStageId ?? null,
  });
  const admittedVersion = result.isReplay
    ? ((await getVersion(db, result.run.flowVersionId)) ?? version)
    : version;
  return { run: result.run, version: admittedVersion, isReplay: result.isReplay };
}

async function runFlow(fence: RunFence, triggerNodeId: string): Promise<void> {
  const ctx = await loadRunContext(fence.flowRunId);
  if (!ctx) return;
  const triggerNode = findNodeById(ctx.graph.nodes, triggerNodeId);
  if (!triggerNode) return;
  await dispatchAndAdvance(fence, triggerNode, undefined, ctx);
}

async function dispatchAdmittedFlow(flowRunId: string, ticket: number): Promise<void> {
  const ctx = await loadRunContext(flowRunId);
  if (!ctx) throw new Error(`Flow run ${flowRunId} has no canonical execution context`);
  const trigger = ctx.graph.nodes.find((node) => isTriggerBlockType(node.blockType));
  if (!trigger) throw new Error(`Flow run ${flowRunId} has no trigger node`);
  // A Cancel that committed after promotion owns the run; its release settles this ticket.
  const fence = readRunFence(getDatabase(), flowRunId, ticket);
  if (!fence) return;
  emitRunStarted(ctx.meta, flowRunId);
  await runFlow(fence, trigger.id);
}

registerFlowAdmissionStartDispatcher(dispatchAdmittedFlow);
