import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { type NodeRun, nodeRuns } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** Identity a start_task surfaces in node_output; downstream blocks reuse its chat + worktree. */
export type StartTaskContext = {
  projectId?: string;
  chatId?: string;
  subChatId?: string;
  taskId?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  /** 'plan' | 'execute' — gates the downstream agent task. */
  startMode?: string;
  /** Start_task's model (PICKER id, e.g. `opus-4.8`); a downstream agent inherits it when it has no own override. */
  model?: string;
  /** Resolved task title (from start_task's Task title field, templates rendered); a downstream agent names its task row from this. */
  label?: string;
};

export type StartTaskScope =
  | { nodeIds: string[]; laneIndex: number; parentFanOutNodeRunId: string }
  | { nodeIds: string[]; outsideFanOut: true };

/**
 * Sync form of findLatestCompletedStartTaskRun (node-runs.ts), so a transaction — the
 * terminal-resume eligibility read — can resolve a run's chat in the same snapshot.
 */
export function findLatestCompletedStartTaskRunSync(
  db: Db,
  flowRunId: string,
  scope?: StartTaskScope,
): NodeRun | null {
  if (scope && scope.nodeIds.length === 0) return null;
  const filters = [
    eq(nodeRuns.flowRunId, flowRunId),
    eq(nodeRuns.blockType, 'start_task'),
    eq(nodeRuns.status, 'completed'),
  ];
  if (scope) {
    filters.push(inArray(nodeRuns.nodeId, scope.nodeIds));
    if ('outsideFanOut' in scope) {
      filters.push(isNull(nodeRuns.laneIndex), isNull(nodeRuns.parentFanOutNodeRunId));
    } else {
      filters.push(
        eq(nodeRuns.laneIndex, scope.laneIndex),
        eq(nodeRuns.parentFanOutNodeRunId, scope.parentFanOutNodeRunId),
      );
    }
  }
  return (
    db
      .select()
      .from(nodeRuns)
      .where(and(...filters))
      .orderBy(desc(nodeRuns.completedAt))
      .limit(1)
      .get() ?? null
  );
}

/** Sync form of resolveUpstreamStartTaskContext (node-runs.ts); see its doc for the scoping rules. */
export function resolveUpstreamStartTaskContextSync(
  db: Db,
  flowRunId: string,
  options?: { nodeRunId: string; upstreamNodeIds: string[] },
): StartTaskContext | null {
  const current = options
    ? (db.select().from(nodeRuns).where(eq(nodeRuns.id, options.nodeRunId)).get() ?? null)
    : null;
  const laneScope =
    options && current?.laneIndex !== null && current?.parentFanOutNodeRunId
      ? {
          nodeIds: options.upstreamNodeIds,
          laneIndex: current.laneIndex,
          parentFanOutNodeRunId: current.parentFanOutNodeRunId,
        }
      : undefined;
  // Outside a lane, only start_tasks outside every Fan Out count — a continuation's upstream
  // walk passes through the lane bodies, and the newest lane start_task must not win (sc-3836).
  const outsideScope = options
    ? { nodeIds: options.upstreamNodeIds, outsideFanOut: true as const }
    : undefined;
  const run =
    (laneScope && findLatestCompletedStartTaskRunSync(db, flowRunId, laneScope)) ||
    findLatestCompletedStartTaskRunSync(db, flowRunId, outsideScope);
  if (!run || run.nodeOutput === null || typeof run.nodeOutput !== 'object') return null;
  const outputs = (run.nodeOutput as { outputs?: unknown }).outputs;
  if (outputs === null || typeof outputs !== 'object') return null;
  return outputs as StartTaskContext;
}
