/**
 * advanceFlowRun — applies a node's NodeOutput, picks the next node, dispatches
 * it, recurses. Single-process equivalent of the cloud engine's
 * advanceFlowRun + dispatchRunnableNode loop.
 *
 * Linear flows only in this pass: fan_out parallel lanes are deferred. Engine
 * walks edges, recursing through completed nodes until it hits a terminal node
 * (`end` block or no outgoing edges) or a paused node (awaiting_input/blocked).
 */

import log from 'electron-log';
import type { NodeOutput } from '../../../shared/types/flow';
import type { FlowResumeSnapshot } from '../../../shared/types/flow-run/resume';
import { getDatabase } from '../db';
import { getFlowRun, setFlowRunStatus } from '../db/repos/flow-runs';
import { getVersion } from '../db/repos/flow-versions';
import { getFlowById } from '../db/repos/flows';
import {
  cancelRemainingNodeRunsForRun,
  listNodeRunsForFlowRun,
  setNodeRunStatus,
} from '../db/repos/node-runs';
import { cancelFlowLinkedTasksForRun, completeDoneTasksForFlowRun } from '../db/repos/tasks';
import { captureContained } from '../sentry';
import { abortFlowRun, registerNodeAbort, unregisterNodeAbort } from './cancel-registry';
import { dispatchNode } from './dispatch';
import { emitNodeStarted, emitNodeTerminal, emitRunPaused, emitRunTerminal } from './event-emit';
import { buildLoopContextFor, type FanOutStepResult, maybeAdvanceFanOut } from './fan-out-step';
import {
  findNodeById,
  type ParsedFlowGraph,
  parseGraph,
  pickNextTargetNodeId,
  resolveFanOutStructure,
} from './graph';
import { withSlot } from './scheduler';
import { insertNodeRunIfLive, runTransition } from './transitions';

type FlowMeta = { flowId: string; flowName: string; batchId?: string };

export type RunContext = {
  meta: FlowMeta;
  graph: ParsedFlowGraph;
  triggerContext: Record<string, unknown> | null;
};

type Db = ReturnType<typeof getDatabase>;
type EmittedTerminalStatus = 'completed' | 'skipped' | 'failed';

const EMITTED_TERMINAL_STATUSES = new Set<NodeOutput['status']>(['completed', 'skipped', 'failed']);

function isEmittedTerminalStatus(status: NodeOutput['status']): status is EmittedTerminalStatus {
  return EMITTED_TERMINAL_STATUSES.has(status);
}

async function dispatchNodeUnlessAborted(
  controller: AbortController,
  input: Parameters<typeof dispatchNode>[0],
) {
  if (controller.signal.aborted) return null;
  const result = await withSlot(async () => {
    if (controller.signal.aborted) return null;
    return dispatchNode(input);
  });
  return controller.signal.aborted ? null : result;
}

async function parkAwaitingInput(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  controller: AbortController,
): Promise<boolean> {
  const parked = await setNodeRunStatus(db, nodeRunId, 'awaiting_input', {
    completedAt: new Date(),
    expectStatuses: ['running'],
  });
  if (!parked || controller.signal.aborted) return false;
  const activeRun = await getFlowRun(db, flowRunId);
  if (activeRun?.status !== 'running' && activeRun?.status !== 'paused') return false;
  const paused = await setFlowRunStatus(db, flowRunId, 'paused', {}, activeRun.status);
  return paused !== null && !controller.signal.aborted;
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

type AdvancedNode = {
  id: string;
  nodeId: string;
  blockType: string;
  laneIndex: number | null;
  parentFanOutNodeRunId: string | null;
};

async function pauseForParkedFanOutSibling(
  db: Db,
  flowRunId: string,
  node: AdvancedNode,
  ctx: RunContext,
): Promise<void> {
  if (!node.parentFanOutNodeRunId) return;
  const parkedSiblings = (await listNodeRunsForFlowRun(db, flowRunId)).filter(
    (nodeRun) =>
      nodeRun.parentFanOutNodeRunId === node.parentFanOutNodeRunId &&
      nodeRun.laneIndex === node.laneIndex &&
      (nodeRun.status === 'awaiting_input' || nodeRun.status === 'blocked'),
  );
  if (parkedSiblings.length === 0) return;
  const paused = await setFlowRunStatus(db, flowRunId, 'paused', {}, 'running');
  if (!paused) return;
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

async function handleFanOutProgress(
  db: Db,
  flowRunId: string,
  node: AdvancedNode,
  output: NodeOutput,
  ctx: RunContext,
): Promise<FanOutStepResult | null> {
  const step = await maybeAdvanceFanOut({
    flowRunId,
    nodeId: node.nodeId,
    laneIndex: node.laneIndex,
    parentFanOutNodeRunId: node.parentFanOutNodeRunId,
    graph: ctx.graph,
  });
  if (step.kind === 'waiting') {
    await pauseForParkedFanOutSibling(db, flowRunId, node, ctx);
    return null;
  }
  if (step.kind === 'next-iteration') {
    await Promise.all(
      step.rootNodes.map((rootNode) =>
        dispatchAndAdvance(
          flowRunId,
          rootNode,
          step.previousOutput,
          ctx,
          step.loopContext,
          undefined,
          {
            laneIndex: step.laneIndex,
            parentFanOutNodeRunId: step.parentFanOutNodeRunId,
          },
        ),
      ),
    );
    return null;
  }
  if (node.blockType !== 'fan_out' || output.outputs?._fanOutState !== 'iterating') return step;

  const resolution = resolveFanOutStructure(ctx.graph.nodes, ctx.graph.edges, node.nodeId);
  if (!resolution.ok) return null;
  const loopContext = {
    currentItem: output.outputs.currentItem,
    currentIndex: output.outputs.currentIndex,
    totalCount: output.outputs.totalCount,
  };
  await Promise.all(
    resolution.structure.branches.map(async (branch) => {
      const rootNode = findNodeById(ctx.graph.nodes, branch.rootNodeId);
      if (!rootNode) return;
      await dispatchAndAdvance(flowRunId, rootNode, output, ctx, loopContext, undefined, {
        laneIndex: 0,
        parentFanOutNodeRunId: node.id,
      });
    }),
  );
  return null;
}

export async function loadRunContext(flowRunId: string): Promise<RunContext | null> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) return null;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return null;
  const flow = await getFlowById(db, version.flowId);
  if (!flow) return null;
  return {
    // batchId marks a batch-member run so its events can be told apart from
    // standalone runs (the renderer keeps members individually silent).
    meta: { flowId: flow.id, flowName: flow.name, batchId: run.batchId ?? undefined },
    graph: parseGraph(version.graph),
    triggerContext: (run.triggerContext as Record<string, unknown> | null) ?? null,
  };
}

async function handleNonProgressOutput(
  db: Db,
  flowRunId: string,
  node: AdvancedNode,
  output: NodeOutput,
  ctx: RunContext,
): Promise<boolean> {
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
    abortFlowRun(flowRunId);
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });
    await cancelRemainingNodeRunsForRun(db, flowRunId);
    await cancelFlowLinkedTasksForRun(db, flowRunId);
    emitRunTerminal(ctx.meta, flowRunId, 'failed', { summary: output.error?.message });
    return true;
  }
  if (output.status === 'awaiting_input' || output.status === 'blocked') {
    await setFlowRunStatus(db, flowRunId, 'paused');
    emitRunPaused(
      ctx.meta,
      flowRunId,
      { [node.nodeId]: { status: output.status } },
      output.userPaused ? 'user' : undefined,
    );
    return true;
  }
  if (output.status !== 'cancelled') return false;

  await setFlowRunStatus(db, flowRunId, 'cancelled', { completedAt: new Date() });
  await cancelRemainingNodeRunsForRun(db, flowRunId);
  await cancelFlowLinkedTasksForRun(db, flowRunId);
  emitRunTerminal(ctx.meta, flowRunId, 'cancelled');
  return true;
}

/**
 * Persist a node's NodeOutput, emit the matching event, then walk forward.
 * Recurses synchronously through nodes that complete in-process; awaits for
 * dispatched async work (today: none — every dispatcher returns synchronously).
 */
export async function advanceFlowRun(
  flowRunId: string,
  nodeRunId: string,
  output: NodeOutput,
  /** Watcher-only: the driving-task row the output was derived from. The node write is refused
   * when that exact row is gone (resumed, or resumed and re-parked) — see setNodeRunStatus. */
  drivingTask?: { id: string; status: string; result: unknown },
  resumeSnapshot?: FlowResumeSnapshot,
): Promise<boolean> {
  const db = getDatabase();
  // Never resurrect a terminal run. The task-completion-watcher can fire advanceFlowRun
  // after a cancel (e.g. the chat was deleted mid agent-task), and an aborted in-process
  // node's catch path would otherwise flip 'cancelled' → 'failed'. Bail before touching state.
  const current = await getFlowRun(db, flowRunId);
  if (
    current &&
    (current.status === 'cancelled' ||
      current.status === 'failed' ||
      current.status === 'completed')
  ) {
    return true;
  }

  // CAS guard: only advance when the node_run is still active. A re-advance of an
  // already-terminal node (e.g. the watcher re-firing a completed task after a restart
  // wiped its in-memory dedup) matches 0 rows here and bails BEFORE re-walking edges —
  // the fix for duplicate downstream dispatch. Mirrors the cloud engine's status-IN CAS.
  const updated = await setNodeRunStatus(db, nodeRunId, output.status, {
    nodeOutput: output,
    completedAt: new Date(),
    expectStatuses: ['running', 'awaiting_input', 'blocked'],
    expectDrivingTask: drivingTask,
    expectResumeSnapshot: resumeSnapshot,
  });
  // False ONLY when a guard was asked for and nothing was written: the caller re-checks its task.
  if (!updated) return !drivingTask && !resumeSnapshot;

  const ctx = await loadRunContext(flowRunId);
  if (!ctx) return true;

  if (await handleNonProgressOutput(db, flowRunId, updated, output, ctx)) return true;

  // status === 'completed' || 'skipped' — walk to next node.
  // Sequential fan_out: when a body-tail node finishes, advance the iteration
  // before falling through to graph edges. 'next-iteration' re-dispatches the
  // body head with a new loopContext; 'finished' walks to the continuation
  // outside the explicitly-owned body.
  const fanOutStep = await handleFanOutProgress(db, flowRunId, updated, output, ctx);
  if (!fanOutStep) return true;

  const fanOutContinuation = fanOutContinuationNodeId(ctx.graph, updated, output, fanOutStep);
  const conditionResult =
    updated.blockType === 'condition'
      ? ((output.outputs?.result as 'continue' | 'stop' | undefined) ?? 'stop')
      : undefined;

  const nextNodeId =
    fanOutContinuation ?? pickNextTargetNodeId(ctx.graph.edges, updated.nodeId, conditionResult);
  if (!nextNodeId) {
    await setFlowRunStatus(db, flowRunId, 'completed', { completedAt: new Date() });
    // Opt-in auto-accept: the flow author pre-authorized skipping the review gate, so the run's
    // `done` tasks finalize straight to `completed`. Default (flag off) leaves them at `done` —
    // the work queue surfaces the flow as Ready for review until the user accepts.
    if (ctx.graph.settings?.autoAcceptCompletedRuns === true) {
      await completeDoneTasksForFlowRun(db, flowRunId);
    }
    emitRunTerminal(ctx.meta, flowRunId, 'completed');
    return true;
  }

  const nextNode = findNodeById(ctx.graph.nodes, nextNodeId);
  if (!nextNode) {
    log.warn('[FlowsEngine] next node id not found in graph', { flowRunId, nextNodeId });
    await setFlowRunStatus(db, flowRunId, 'failed', { completedAt: new Date() });
    await cancelRemainingNodeRunsForRun(db, flowRunId);
    await cancelFlowLinkedTasksForRun(db, flowRunId);
    emitRunTerminal(ctx.meta, flowRunId, 'failed', {
      summary: `Edge target ${nextNodeId} not in graph`,
    });
    return true;
  }

  const fanOutScope =
    fanOutStep.kind === 'not-fan-out' && updated.parentFanOutNodeRunId
      ? {
          laneIndex: updated.laneIndex ?? undefined,
          parentFanOutNodeRunId: updated.parentFanOutNodeRunId,
        }
      : undefined;
  await dispatchAndAdvance(
    flowRunId,
    nextNode,
    outputAfterFanOut(fanOutStep, output),
    ctx,
    undefined,
    undefined,
    fanOutScope,
  );
  return true;
}

/** Internal: insert node_run, register abort, dispatch, recurse on result. */
export async function dispatchAndAdvance(
  flowRunId: string,
  node: { id: string; blockType: string; label?: string; config?: Record<string, unknown> },
  previousOutput: NodeOutput | undefined,
  ctx: RunContext,
  explicitLoopContext?: Record<string, unknown>,
  releaseAbortRegistration?: () => void,
  options?: {
    resumeKind?: 'continuation' | 'redispatch';
    laneIndex?: number;
    parentFanOutNodeRunId?: string;
  },
): Promise<void> {
  const db = getDatabase();
  // Inject fan_out loopContext when this node is part of a body chain, unless
  // the caller already supplied one (the iteration-step path passes it through
  // explicitly to avoid an extra KV roundtrip).
  const loopContext = explicitLoopContext ?? (await buildLoopContextFor(flowRunId, node.id));

  // The insert and the abort registration share one tick: a Cancel that commits first makes the
  // insert decline, and one that commits later finds this controller to abort.
  const inserted = runTransition(db, () =>
    insertNodeRunIfLive(db, {
      flowRunId,
      nodeId: node.id,
      blockType: node.blockType,
      status: 'running',
      startedAt: new Date(),
      laneIndex: options?.laneIndex,
      parentFanOutNodeRunId: options?.parentFanOutNodeRunId,
    }),
  );
  if (!inserted) return;
  const controller = new AbortController();
  registerNodeAbort(flowRunId, controller);
  releaseAbortRegistration?.();
  emitNodeStarted(ctx.meta, flowRunId, node.id, node.blockType, node.label);

  try {
    const result = await dispatchNodeUnlessAborted(controller, {
      flowRunId,
      nodeRunId: inserted.id,
      node: { id: node.id, blockType: node.blockType, label: node.label, config: node.config },
      previousOutput,
      triggerContext: ctx.triggerContext,
      loopContext,
      parsedGraph: ctx.graph,
      signal: controller.signal,
      resumeKind: options?.resumeKind,
    });
    if (!result) return;

    if (result.type === 'awaiting_input') {
      if (!(await parkAwaitingInput(db, flowRunId, inserted.id, controller))) return;
      // An agent hand-off waits on the machine and happens on every advance; an approval block
      // (or a merge conflict) waits on the user. Only the latter is user-facing signal.
      emitRunPaused(
        ctx.meta,
        flowRunId,
        { [node.id]: { status: 'awaiting_input' } },
        result.handoff ? 'agent-handoff' : undefined,
      );
      return;
    }
    if (result.type === 'error') {
      await advanceFlowRun(flowRunId, inserted.id, {
        status: 'failed',
        outputs: {},
        artifacts: [],
        durationMs: 0,
        error: { message: result.message, retryable: false },
      });
      return;
    }
    await advanceFlowRun(flowRunId, inserted.id, result.output);
  } catch (err) {
    // A dispatcher that THROWS must still terminalize its node. Without this the run sits in
    // 'running' forever: the trigger entry point is `void runFlow(...).catch(log.error)`
    // (start.ts), so the only trace is one log line and the user sees a hung flow.
    //
    // An abort is NOT a failure, and the terminal-run bail in advanceFlowRun is not enough to
    // cover it: cancelFlowRun aborts the controller BEFORE it writes 'cancelled', so a thrown
    // AbortError can arrive here while the run is still non-terminal and would flip a cancel
    // into a failure. Gate on the signal itself and let the canceller own the terminal state.
    if (controller.signal.aborted) return;

    const message = err instanceof Error ? err.message : String(err);
    log.error('[FlowsEngine] node dispatch threw', {
      flowRunId,
      nodeId: node.id,
      blockType: node.blockType,
      err,
    });
    // The run is terminalized below, so nothing downstream ever reports this — a dispatcher
    // crashing for every user would otherwise show up only as failed runs with no cause.
    captureContained(err, { surface: 'flow-dispatch', blockType: node.blockType });
    await advanceFlowRun(flowRunId, inserted.id, {
      status: 'failed',
      outputs: {},
      artifacts: [],
      durationMs: 0,
      error: { message, retryable: false },
    });
  } finally {
    unregisterNodeAbort(flowRunId, controller);
  }
}
