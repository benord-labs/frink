import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { type NodeOutput, SUPERSEDED_NODE_STATUS } from '../../../../shared/types/flow';
import type { getDatabase } from '../../db';
import { type NodeRun, nodeRuns } from '../../db/schema';
import { insertNodeRunIfFenced, type RunFence } from './fence';

type Db = ReturnType<typeof getDatabase>;

/** How many times one node may be dispatched in one attempt slot of one admission before the run
 * fails as a likely endless loop. Matches the Fan Out iteration cap. */
export const MAX_NODE_DISPATCHES_PER_ADMISSION = 50;

export type DispatchSlot = {
  nodeId: string;
  laneIndex?: number | null;
  parentFanOutNodeRunId?: string | null;
};

/** Rows dispatched for `slot` under the fence's admission, superseded Retry attempts excluded. A slot
 * is one node inside one Fan Out item (or outside any), so each item gets its own budget. */
export function countSlotDispatches(db: Db, fence: RunFence, slot: DispatchSlot): number {
  const row = db
    .select({ n: count() })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.flowRunId, fence.flowRunId),
        eq(nodeRuns.nodeId, slot.nodeId),
        eq(nodeRuns.admissionTicket, fence.ticket),
        slot.parentFanOutNodeRunId == null
          ? isNull(nodeRuns.parentFanOutNodeRunId)
          : eq(nodeRuns.parentFanOutNodeRunId, slot.parentFanOutNodeRunId),
        slot.laneIndex == null
          ? isNull(nodeRuns.laneIndex)
          : eq(nodeRuns.laneIndex, slot.laneIndex),
        ne(nodeRuns.status, SUPERSEDED_NODE_STATUS),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** Fenced insert of the node's `running` row, plus whether it is past the ceiling — counted from
 * persisted rows in the same tick, so watcher-driven hops count too. Runs inside `runTransition`. */
export function insertNodeRunUnderCeiling(
  db: Db,
  fence: RunFence,
  node: { id: string; blockType: string },
  options?: { laneIndex?: number; parentFanOutNodeRunId?: string; supersedesNodeRunId?: string },
): { row: NodeRun; overLimit: boolean } | null {
  const slot = {
    nodeId: node.id,
    laneIndex: options?.laneIndex,
    parentFanOutNodeRunId: options?.parentFanOutNodeRunId,
  };
  const row = insertNodeRunIfFenced(
    db,
    fence,
    { ...slot, blockType: node.blockType, status: 'running', startedAt: new Date() },
    options?.supersedesNodeRunId,
  );
  if (!row) return null;
  return {
    row,
    overLimit: countSlotDispatches(db, fence, slot) > MAX_NODE_DISPATCHES_PER_ADMISSION,
  };
}

/** The failed output a node past the ceiling ends with; it names the node and the limit. */
export function dispatchCeilingFailure(node: { id: string; label?: string }): NodeOutput {
  const message =
    `Node "${node.label?.trim() || node.id}" was dispatched more than ${MAX_NODE_DISPATCHES_PER_ADMISSION} ` +
    'times in this run, so the run was stopped to break a likely endless loop. ' +
    'Check that the loop has an exit path.';
  return {
    status: 'failed',
    outputs: {},
    artifacts: [],
    durationMs: 0,
    error: { message, retryable: false },
  };
}
