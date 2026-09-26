import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

type NodeExecStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'awaiting_input' | 'blocked';

type NodeExecState = {
  status: NodeExecStatus;
  loopIteration?: number;
  /** Total iterations/lanes in the fan-out — set alongside loopIteration on node_started events. */
  loopTotalCount?: number;
  /** Timestamp (ms) after which a 'running' state can be replaced with a terminal state. */
  runningUntil?: number;
};

type FlowRunExecState = {
  flowRunId: string;
  isLive: boolean;
  /** True when overlay was painted from run history (not live socket execution). */
  isHistoricalInspection: boolean;
};

/**
 * Run-level execution state keyed by flowId.
 * Tracks whether a run is currently live for each flow.
 */
export const flowCanvasExecutionAtom = atom<Record<string, FlowRunExecState>>({});

/** Current sequential fan-out loop progress for Run History panel (one row per flow). */
export type FlowLoopProgress = {
  loopIteration: number;
  loopTotalCount: number;
};

/**
 * Per-flow loop progress for the currently live running sequential fan-out.
 * Null when no loop is active or when parallel fan-out (no fanOutNodeId on events).
 */
export const flowLoopProgressAtomFamily = atomFamily((_flowId: string) =>
  atom<FlowLoopProgress | null>(null),
);

/**
 * Per-node execution state keyed by `${flowId}:${nodeId}`.
 * Each node component reads its own atom independently — prevents all-node re-renders.
 */
export const nodeExecAtomFamily = atomFamily((_key: string) => atom<NodeExecState | null>(null));
