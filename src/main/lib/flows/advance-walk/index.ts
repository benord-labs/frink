/**
 * What runs after a node's output is recorded: ends or pauses the run, steps a Fan Out, or names
 * the next node(s) for the advance walk (advance.ts) to dispatch.
 */

import log from 'electron-log';
import { CONDITION_TRUE_RESULT, type NodeOutput } from '../../../../shared/types/flow';
import type { getDatabase } from '../../db';
import { cancelRemainingNodeRunsForRun, listNodeRunsForFlowRun } from '../../db/repos/node-runs';
import { cancelFlowLinkedTasksForRun, completeDoneTasksForFlowRun } from '../../db/repos/tasks';
import { captureContained } from '../../sentry';
import { abortFlowRun } from '../cancel-registry';
import type { DispatchContext } from '../dispatch/types';
import { emitNodeTerminal, emitRunPaused, emitRunTerminal } from '../event-emit';
import { type FanOutStepResult, maybeAdvanceFanOut } from '../fan-out-step';
import {
  findNodeById,
  type FlowGraphNode,
  type ParsedFlowGraph,
  pickNextTargetNodeId,
  resolveFanOutStructure,
} from '../graph';
import type { RunContext } from './run-context';
import { type RunFence, setFencedRunStatus } from '../transitions';

type Db = ReturnType<typeof getDatabase>;

export type DispatchOptions = {
  resumeKind?: 'continuation';
  laneIndex?: number;
  parentFanOutNodeRunId?: string;
  /** A user Retry: the attempt this dispatch replaces (see insertNodeRunIfFenced). */
  supersedesNodeRunId?: string;
};

/** One node the walk is about to dispatch. */
export type NextDispatch = {
  node: Pick<FlowGraphNode, 'id' | 'blockType' | 'label' | 'config'>;
  previousOutput: NodeOutput | undefined;
  /** Supplied by the iteration-step path; otherwise looked up at dispatch. */
  loopContext?: DispatchContext['loopContext'];
  options?: DispatchOptions;
};

type EmittedTerminalStatus = 'completed' | 'skipped' | 'failed';

const EMITTED_TERMINAL_STATUSES = new Set<NodeOutput['status']>(['completed', 'skipped', 'failed']);

function isEmittedTerminalStatus(status: NodeOutput['status']): status is EmittedTerminalStatus {
  return EMITTED_TERMINAL_STATUSES.has(status);
}

function fanOutContinuationNodeId(
  graph: ParsedFlowGraph,
  node: { nodeId: string; blockType: string },
  output: NodeOutput,
  step: FanOutStepResult,
): string | undefined {
  const fanOutNodeId =
    step.kind === 'finished'
      ? step.fanOutNodeId
      : node.blockType === 'fan_out' && output.outputs?._fanOutState === 'completed'
        ? node.nodeId
        : undefined;
  if (!fanOutNodeId) return undefined;
  const resolution = resolveFanOutStructure(graph.nodes, graph.edges, fanOutNodeId);
  return resolution.ok ? resolution.structure.continuationNodeId : undefined;
}

function outputAfterFanOut(step: FanOutStepResult, output: NodeOutput): NodeOutput {
  if (step.kind !== 'finished') return output;
  return {
    status: 'completed',
    outputs: {
      results: step.aggregateOutputs,
      totalCount: step.aggregateOutputs.length,
      _fanOutState: 'completed',
    },
    artifacts: [],
    durationMs: 0,
  };
}

export type AdvancedNode = {
  id: string;
  nodeId: string;
  blockType: string;
  laneIndex: number | null;
  parentFanOutNodeRunId: string | null;
};

// dispatchCondition always sets `result`, so a bad one is a broken invariant: report it, then fail
// closed to 'stop' like evaluateCondition — the true branch would run gated nodes on unchecked data.
function conditionResultOf(flowRunId: string, node: AdvancedNode, output: NodeOutput) {
  const result = output.outputs?.result;
  if (result === CONDITION_TRUE_RESULT || result === 'stop') return result;

  log.error('[FlowsEngine] condition advanced without a valid result; taking false branch', {
    flowRunId,
    nodeId: node.nodeId,
    result,
  });
  captureContained(new Error('Condition node advanced without a valid result'), {
    surface: 'flow-condition-result',
    blockType: node.blockType,
  });
  return 'stop';
}

async function pauseForParkedFanOutSibling(
  db: Db,
  fence: RunFence,
  node: AdvancedNode,
  ctx: RunContext,
): Promise<void> {
  const { flowRunId } = fence;
  if (!node.parentFanOutNodeRunId) return;
  const parkedSiblings = (await listNodeRunsForFlowRun(db, flowRunId)).filter(
    (nodeRun) =>
      nodeRun.parentFanOutNodeRunId === node.parentFanOutNodeRunId &&
      nodeRun.laneIndex === node.laneIndex &&
      (nodeRun.status === 'awaiting_input' || nodeRun.status === 'blocked'),
  );
  if (parkedSiblings.length === 0) return;
  if (!setFencedRunStatus(db, fence, 'paused', {}, ['running'])) return;
  emitRunPaused(
    ctx.meta,
    flowRunId,
    Object.fromEntries(
      parkedSiblings.map((nodeRun) => [
        nodeRun.nodeId,
        { status: nodeRun.status === 'blocked' ? 'blocked' : 'awaiting_input' },
      ]),
    ),
  );
}

/** The Fan Out step this output completes, or — when the Fan Out itself decides what runs next —
 * the dispatches to make (none while it waits on a parked or unfinished branch). */
async function handleFanOutProgress(
  db: Db,
  fence: RunFence,
  node: AdvancedNode,
  output: NodeOutput,
  ctx: RunContext,
): Promise<FanOutStepResult | NextDispatch[]> {
  const step = await maybeAdvanceFanOut({
    flowRunId: fence.flowRunId,
    nodeId: node.nodeId,
    laneIndex: node.laneIndex,
    parentFanOutNodeRunId: node.parentFanOutNodeRunId,
    graph: ctx.graph,
  });
  if (step.kind === 'waiting') {
    await pauseForParkedFanOutSibling(db, fence, node, ctx);
    return [];
  }
  if (step.kind === 'next-iteration') {
    return step.rootNodes.map((rootNode) => ({
      node: rootNode,
      previousOutput: step.previousOutput,
      loopContext: step.loopContext,
      options: {
        laneIndex: step.laneIndex,
        parentFanOutNodeRunId: step.parentFanOutNodeRunId,
      },
    }));
  }
  if (node.blockType !== 'fan_out' || output.outputs?._fanOutState !== 'iterating') return step;

  const resolution = resolveFanOutStructure(ctx.graph.nodes, ctx.graph.edges, node.nodeId);
  if (!resolution.ok) return [];
  const loopContext = {
    currentItem: output.outputs.currentItem,
    currentIndex: output.outputs.currentIndex,
    totalCount: output.outputs.totalCount,
  };
  return resolution.structure.branches.flatMap((branch) => {
    const rootNode = findNodeById(ctx.graph.nodes, branch.rootNodeId);
    if (!rootNode) return [];
    return [
      {
        node: rootNode,
        previousOutput: output,
        loopContext,
        options: { laneIndex: 0, parentFanOutNodeRunId: node.id },
      },
    ];
  });
}

/** Terminal write gated on the fence, so a Cancel that committed mid-advance is never overwritten
 * and only the winning write sweeps and emits. `ctx` is null only when it could not be loaded. */
export async function endRun(
  db: Db,
  fence: RunFence,
  status: 'failed' | 'cancelled',
  ctx: RunContext | null,
  summary?: string,
): Promise<void> {
  const { flowRunId } = fence;
  if (!setFencedRunStatus(db, fence, status, { completedAt: new Date() })) return;
  if (status === 'failed') abortFlowRun(flowRunId);
  await cancelRemainingNodeRunsForRun(db, flowRunId);
  await cancelFlowLinkedTasksForRun(db, flowRunId);
  if (ctx) emitRunTerminal(ctx.meta, flowRunId, status, { summary });
}

async function completeRun(db: Db, fence: RunFence, ctx: RunContext): Promise<void> {
  if (!setFencedRunStatus(db, fence, 'completed', { completedAt: new Date() })) return;
  // Opt-in auto-accept: the author pre-authorized skipping review, so `done` tasks finalize to
  // `completed`; by default they stay `done` and the queue shows the run as Ready for review.
  if (ctx.graph.settings?.autoAcceptCompletedRuns === true) {
    await completeDoneTasksForFlowRun(db, fence.flowRunId);
  }
  emitRunTerminal(ctx.meta, fence.flowRunId, 'completed');
}

async function handleNonProgressOutput(
  db: Db,
  fence: RunFence,
  node: AdvancedNode,
  output: NodeOutput,
  ctx: RunContext,
): Promise<boolean> {
  const { flowRunId } = fence;
  if (isEmittedTerminalStatus(output.status)) {
    emitNodeTerminal(
      ctx.meta,
      flowRunId,
      output.status,
      node.nodeId,
      node.blockType,
      output.durationMs,
    );
  }

  if (output.status === 'failed') {
    await endRun(db, fence, 'failed', ctx, output.error?.message);
    return true;
  }
  if (output.status === 'awaiting_input' || output.status === 'blocked') {
    if (!setFencedRunStatus(db, fence, 'paused')) return true;
    emitRunPaused(
      ctx.meta,
      flowRunId,
      { [node.nodeId]: { status: output.status } },
      output.userPaused ? 'user' : undefined,
    );
    return true;
  }
  if (output.status !== 'cancelled') return false;
  await endRun(db, fence, 'cancelled', ctx);
  return true;
}

/** What runs after `node` produced `output`: nothing when the run ended, paused or is waiting. */
export async function nextDispatchesAfter(
  db: Db,
  fence: RunFence,
  node: AdvancedNode,
  output: NodeOutput,
  ctx: RunContext,
): Promise<NextDispatch[]> {
  const { flowRunId } = fence;
  if (await handleNonProgressOutput(db, fence, node, output, ctx)) return [];

  // Completed or skipped. A Fan Out body tail steps its iteration before any graph edge is
  // followed: the next item's roots, or (once finished) the continuation outside the body.
  const fanOutStep = await handleFanOutProgress(db, fence, node, output, ctx);
  if (Array.isArray(fanOutStep)) return fanOutStep;

  const fanOutContinuation = fanOutContinuationNodeId(ctx.graph, node, output, fanOutStep);
  const conditionResult =
    node.blockType === 'condition' ? conditionResultOf(flowRunId, node, output) : undefined;

  const nextNodeId =
    fanOutContinuation ?? pickNextTargetNodeId(ctx.graph.edges, node.nodeId, conditionResult);
  if (!nextNodeId) {
    await completeRun(db, fence, ctx);
    return [];
  }

  const nextNode = findNodeById(ctx.graph.nodes, nextNodeId);
  if (!nextNode) {
    log.warn('[FlowsEngine] next node id not found in graph', { flowRunId, nextNodeId });
    await endRun(db, fence, 'failed', ctx, `Edge target ${nextNodeId} not in graph`);
    return [];
  }

  const fanOutScope =
    fanOutStep.kind === 'not-fan-out' && node.parentFanOutNodeRunId
      ? {
          laneIndex: node.laneIndex ?? undefined,
          parentFanOutNodeRunId: node.parentFanOutNodeRunId,
        }
      : undefined;
  return [
    {
      node: nextNode,
      previousOutput: outputAfterFanOut(fanOutStep, output),
      options: fanOutScope,
    },
  ];
}
