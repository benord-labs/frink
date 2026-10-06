/** Persisted Fan Out branch barrier and sequential item advancement. */

import log from 'electron-log';
import type { NodeOutput } from '../../../shared/types/flow';
import { getDatabase } from '../db';
import { getFlowRun } from '../db/repos/flow-runs';
import { getVersion } from '../db/repos/flow-versions';
import { listNodeRunsForFlowRun } from '../db/repos/node-runs';
import {
  claimFanOutState,
  clearBodyMembers,
  clearFanOutState,
  type FanOutIterationState,
  loadBodyMember,
  loadFanOutState,
} from './fan-out-state';
import { iterationOutput, laneItemOutputs } from './fan-out';
import { findNodeById, type ParsedFlowGraph } from './graph';

type FanOutRootNode = {
  id: string;
  blockType: string;
  label?: string;
  config?: NodeOutput['outputs'];
};

type FlowLoopContext = {
  currentItem: unknown;
  currentIndex: number;
  totalCount: number;
};

export type FanOutStepResult =
  | {
      kind: 'next-iteration';
      rootNodes: FanOutRootNode[];
      previousOutput: NodeOutput;
      loopContext: FlowLoopContext;
      laneIndex: number;
      parentFanOutNodeRunId: string;
    }
  | {
      kind: 'finished';
      fanOutNodeId: string;
      aggregateOutputs: Array<NodeOutput['outputs']>;
    }
  | { kind: 'waiting' }
  | { kind: 'not-fan-out' };

export async function maybeAdvanceFanOut(args: {
  flowRunId: string;
  nodeId: string;
  laneIndex: number | null;
  parentFanOutNodeRunId: string | null;
  graph: ParsedFlowGraph;
}): Promise<FanOutStepResult> {
  const bodyNode = findNodeById(args.graph.nodes, args.nodeId);
  if (!bodyNode?.parentId) return { kind: 'not-fan-out' };

  const db = getDatabase();
  const run = await getFlowRun(db, args.flowRunId);
  if (!run) return { kind: 'waiting' };
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return { kind: 'waiting' };
  const flowId = version.flowId;
  const fanOutNodeId = bodyNode.parentId;
  const state = await loadFanOutState(flowId, args.flowRunId, fanOutNodeId);
  if (!state) {
    log.error('[fan_out] contained node is missing iteration state', {
      flowRunId: args.flowRunId,
      nodeId: args.nodeId,
      fanOutNodeId,
    });
    return { kind: 'waiting' };
  }

  const completingBranch = state.branches.find((branch) => branch.tailNodeId === args.nodeId);
  if (!completingBranch) return { kind: 'not-fan-out' };
  if (args.laneIndex !== state.currentIndex || !args.parentFanOutNodeRunId) {
    return { kind: 'waiting' };
  }

  const tailIds = new Set(state.branches.map((branch) => branch.tailNodeId));
  const completedTails = (await listNodeRunsForFlowRun(db, args.flowRunId)).filter(
    (nodeRun) =>
      nodeRun.parentFanOutNodeRunId === args.parentFanOutNodeRunId &&
      nodeRun.laneIndex === state.currentIndex &&
      tailIds.has(nodeRun.nodeId) &&
      (nodeRun.status === 'completed' || nodeRun.status === 'skipped'),
  );
  if (completedTails.length !== state.branches.length) return { kind: 'waiting' };

  const itemOutputs = laneItemOutputs(state.branches, completedTails);
  const nextIndex = state.currentIndex + 1;
  const nextState = {
    ...state,
    currentIndex: nextIndex,
    completedOutputs: [...state.completedOutputs, itemOutputs],
  };
  const claimed = await claimFanOutState(
    flowId,
    args.flowRunId,
    fanOutNodeId,
    state.currentIndex,
    nextState,
  );
  if (!claimed) return { kind: 'waiting' };

  if (nextIndex >= state.totalCount) {
    await clearFanOutState(flowId, args.flowRunId, fanOutNodeId);
    await clearBodyMembers(
      flowId,
      args.flowRunId,
      state.branches.flatMap((branch) => branch.nodeIds),
    );
    return {
      kind: 'finished',
      fanOutNodeId,
      aggregateOutputs: nextState.completedOutputs,
    };
  }

  const rootNodes = state.branches
    .map((branch) => findNodeById(args.graph.nodes, branch.rootNodeId))
    .filter((node): node is FanOutRootNode => node !== undefined);
  if (rootNodes.length !== state.branches.length) return { kind: 'waiting' };
  return {
    kind: 'next-iteration',
    rootNodes,
    previousOutput: iterationOutput(nextState, nextIndex),
    loopContext: {
      currentItem: state.items[nextIndex],
      currentIndex: nextIndex,
      totalCount: state.totalCount,
    },
    laneIndex: nextIndex,
    parentFanOutNodeRunId: args.parentFanOutNodeRunId,
  };
}

/** Build loop context for a contained node from its owning Fan Out's current item. */
export async function buildLoopContextFor(
  flowRunId: string,
  nodeId: string,
): Promise<FlowLoopContext | undefined> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run) return undefined;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return undefined;
  const flowId = version.flowId;

  const member = await loadBodyMember(flowId, flowRunId, nodeId);
  if (!member) return undefined;
  const state = await loadFanOutState(flowId, flowRunId, member.fanOutNodeId);
  if (!state) return undefined;
  return {
    currentItem: state.items[state.currentIndex],
    currentIndex: state.currentIndex,
    totalCount: state.totalCount,
  };
}

/** Live iteration state of the Fan Out owning a body node; undefined outside one or after teardown. */
export async function loadOwningFanOutState(
  flowId: string,
  flowRunId: string,
  node: { parentId?: string },
): Promise<FanOutIterationState | undefined> {
  if (!node.parentId) return undefined;
  return (await loadFanOutState(flowId, flowRunId, node.parentId)) ?? undefined;
}
