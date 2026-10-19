/**
 * KV-typed wrappers around `flow_kv_state` for fan_out iteration tracking.
 *
 * Two key shapes (mirrors cloud):
 *   _fanOut:<flowRunId>:<nodeId>            → FanOutIterationState
 *   _fanOutBodyMember:<flowRunId>:<nodeId>  → FanOutBodyMemberEntry
 *
 * Body-member entries provide O(1) reverse lookup from any chain node to its
 * owning fan_out, used by advance.ts to detect "we're inside a fan_out body"
 * when emitting node_started events.
 */

import { and, eq, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { FanOutBranch } from '../../../shared/lib/compute-fan-out-body-chain';
import type { NodeOutput } from '../../../shared/types/flow';
import { getDatabase } from '../db';
import { deleteKv, getKv, setKv } from '../db/repos/flow-kv-state';
import { flowKvState } from '../db/schema';

export type FanOutIterationState = {
  items: unknown[];
  currentIndex: number;
  totalCount: number;
  maxIterations: number;
  completedOutputs: Array<NodeOutput['outputs']>;
  arrayField: string;
  truncated?: boolean;
  originalCount?: number;
  branches: FanOutBranch[];
  mode?: 'parallel';
  laneCount?: number;
  currentWaveLaneCount?: number;
};

export type FanOutBodyMemberEntry = {
  fanOutNodeId: string;
  chainIndex: number;
  flowId: string;
};

const STATE_KEY_PREFIX = '_fanOut:';

const stateKey = (flowRunId: string, fanOutNodeId: string): string =>
  `${STATE_KEY_PREFIX}${flowRunId}:${fanOutNodeId}`;

/**
 * True when `nodeRunId` ran in a Fan Out item the loop has already moved past: only the item at
 * `currentIndex` is live, and the state row is deleted after the last item. Sequential mode only.
 */
export function isPastFanOutLane(nodeRunId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM node_runs fo_lane
    JOIN node_runs fo_fan ON fo_fan.id = fo_lane.parent_fan_out_node_run_id
    JOIN flow_runs fo_run ON fo_run.id = fo_lane.flow_run_id
    JOIN flow_versions fo_ver ON fo_ver.id = fo_run.flow_version_id
    WHERE fo_lane.id = ${nodeRunId} AND NOT EXISTS (SELECT 1 FROM flow_kv_state fo_kv
      WHERE fo_kv.flow_id = fo_ver.flow_id
        AND fo_kv.key = ${STATE_KEY_PREFIX} || fo_lane.flow_run_id || ':' || fo_fan.node_id
        AND json_extract(fo_kv.value, '$.currentIndex') = fo_lane.lane_index))`;
}

const memberKey = (flowRunId: string, chainNodeId: string): string =>
  `_fanOutBodyMember:${flowRunId}:${chainNodeId}`;

async function loadFanOutKv<T>(flowId: string, key: string): Promise<T | null> {
  const row = await getKv(getDatabase(), flowId, key);
  // SAFETY: callers select the persisted value through the key-specific wrapper below.
  return row ? (row.value as T) : null;
}

export async function loadFanOutState(
  flowId: string,
  flowRunId: string,
  fanOutNodeId: string,
): Promise<FanOutIterationState | null> {
  return loadFanOutKv<FanOutIterationState>(flowId, stateKey(flowRunId, fanOutNodeId));
}

export async function saveFanOutState(
  flowId: string,
  flowRunId: string,
  fanOutNodeId: string,
  state: FanOutIterationState,
): Promise<void> {
  await setKv(getDatabase(), flowId, stateKey(flowRunId, fanOutNodeId), state);
}

/** Claim one item barrier. Only one racing branch tail can advance a given item index. */
export async function claimFanOutState(
  flowId: string,
  flowRunId: string,
  fanOutNodeId: string,
  expectedIndex: number,
  state: FanOutIterationState,
): Promise<boolean> {
  const db = getDatabase();
  const [claimed] = await db
    .update(flowKvState)
    .set({ value: state, updatedAt: new Date() })
    .where(
      and(
        eq(flowKvState.flowId, flowId),
        eq(flowKvState.key, stateKey(flowRunId, fanOutNodeId)),
        sql`json_extract(${flowKvState.value}, '$.currentIndex') = ${expectedIndex}`,
      ),
    )
    .returning({ id: flowKvState.id });
  return claimed !== undefined;
}

export async function clearFanOutState(
  flowId: string,
  flowRunId: string,
  fanOutNodeId: string,
): Promise<void> {
  await deleteKv(getDatabase(), flowId, stateKey(flowRunId, fanOutNodeId));
}

export async function loadBodyMember(
  flowId: string,
  flowRunId: string,
  chainNodeId: string,
): Promise<FanOutBodyMemberEntry | null> {
  return loadFanOutKv<FanOutBodyMemberEntry>(flowId, memberKey(flowRunId, chainNodeId));
}

export async function saveBodyMembers(
  flowId: string,
  flowRunId: string,
  bodyNodeIds: string[],
  fanOutNodeId: string,
): Promise<void> {
  const db = getDatabase();
  for (let i = 0; i < bodyNodeIds.length; i += 1) {
    const entry: FanOutBodyMemberEntry = { fanOutNodeId, chainIndex: i, flowId };
    await setKv(db, flowId, memberKey(flowRunId, bodyNodeIds[i]), entry);
  }
}

export async function clearBodyMembers(
  flowId: string,
  flowRunId: string,
  bodyNodeIds: string[],
): Promise<void> {
  const db = getDatabase();
  for (const chainNodeId of bodyNodeIds) {
    await deleteKv(db, flowId, memberKey(flowRunId, chainNodeId));
  }
}
