/** Batch dependency-branch inheritance (sc-3845): dependent stage runs fork from their completed
 * dependencies' branches, which start_task provisions / converge-merges into the worktree. */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { getDatabase } from '../../db';
import { listLatestCompletedTopLevelStartTaskRuns } from '../../db/repos/node-runs';
import { type BatchStage, batchStageRuns, flowRuns } from '../../db/schema';
import { stageDeps } from '../batch-context';

type Db = ReturnType<typeof getDatabase>;

/** Intra-second tie-break (completed_at is second-precision): the run whose last node started latest
 * finished last. Hand-qualified: an interpolated column renders unqualified and binds to node_runs.id. */
const LAST_NODE_SEQ = sql<
  number | null
>`(SELECT MAX(rowid) FROM node_runs nr WHERE nr.flow_run_id = "flow_runs"."id")`;

const START_TASK_BRANCH = z.object({ outputs: z.object({ branch: z.string() }) });

/** Branch a completed start_task worked on, or null (no worktree emits branch ''). */
function startTaskBranch(nodeOutput: unknown): string | null {
  const parsed = START_TASK_BRANCH.safeParse(nodeOutput);
  const branch = parsed.success ? parsed.data.outputs.branch.trim() : '';
  return branch.length > 0 ? branch : null;
}

/**
 * Branches from every completed run in every dependency of `stage`, most recently completed first,
 * deduplicated. Failed / cancelled members contribute nothing. Roots resolve to [].
 */
export async function resolveDependencyBranches(db: Db, stage: BatchStage): Promise<string[]> {
  const deps = stageDeps(stage);
  if (deps.length === 0) return [];
  const members = await db
    .select({ flowRunId: batchStageRuns.flowRunId })
    .from(batchStageRuns)
    .where(and(inArray(batchStageRuns.stageId, deps), eq(batchStageRuns.status, 'completed')));
  const flowRunIds = members.flatMap((m) => (m.flowRunId ? [m.flowRunId] : []));
  if (flowRunIds.length === 0) return [];

  const runs = await db
    .select({
      id: flowRuns.id,
      completedAt: flowRuns.completedAt,
      lastNodeSeq: LAST_NODE_SEQ,
    })
    .from(flowRuns)
    .where(inArray(flowRuns.id, flowRunIds));
  const startTasks = await listLatestCompletedTopLevelStartTaskRuns(db, flowRunIds);

  const candidates = runs
    .map((run) => ({
      ...run,
      completedAt: run.completedAt?.getTime() ?? -1,
      lastNodeSeq: run.lastNodeSeq ?? -1,
      branch: startTaskBranch(startTasks.get(run.id)?.nodeOutput),
    }))
    .filter((c): c is typeof c & { branch: string } => c.branch !== null)
    .sort(
      (a, b) =>
        b.completedAt - a.completedAt || b.lastNodeSeq - a.lastNodeSeq || a.id.localeCompare(b.id),
    );
  return [...new Set(candidates.map((c) => c.branch))];
}

/**
 * Point the run at its dependency branches, overwriting any planner-set base (decision
 * batch-stage-branch-strategy: a dependent stage ALWAYS forks off its deps). No branches → unchanged.
 */
export function mergeDependencyBranches(
  ctx: Record<string, unknown> | null,
  branches: string[],
): Record<string, unknown> | null {
  if (branches.length === 0) return ctx;
  const { mergeStrategy: _stale, ...rest } = ctx ?? {};
  return {
    ...rest,
    baseBranch: branches[0],
    baseBranches: branches,
    ...(branches.length >= 2 ? { mergeStrategy: 'most-recent' } : {}),
  };
}
