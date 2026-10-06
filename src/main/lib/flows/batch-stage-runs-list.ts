/** One stage's batch_stage_runs, paginated, as BatchStageRunRow: start_task fields (merge conflicts),
 * needs_input (listHumanWaitFlowRunIds), chat_id and timestamps from the linked flow_run. */

import { asc, sql as drizzleSql, eq } from 'drizzle-orm';
import type { BatchStageRunRow } from '../../../shared/types/flow';
import { getDatabase } from '../db';
import {
  listHumanWaitFlowRunIds,
  listLatestStartTaskRunsByFlowRunIds,
} from '../db/repos/node-runs';
import { batchStageRuns, flowRuns, type NodeRun } from '../db/schema';
import { resolveBatchRunChatIds } from './batch-runs-list';

export type ListBatchStageRunsOptions = {
  limit?: number;
  offset?: number;
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** Converging-merge fields from a start_task's node_output.outputs (camelCase at rest). */
function convergeMergeFields(outputs: Record<string, unknown>): Partial<BatchStageRunRow> {
  const fields: Partial<BatchStageRunRow> = {};
  if (outputs.mergeConflict === true) fields.merge_conflict = true;
  if (typeof outputs.conflictingBranch === 'string') {
    fields.conflicting_branch = outputs.conflictingBranch;
  }
  const conflictedFiles = stringArray(outputs.conflictedFiles);
  if (conflictedFiles) fields.conflicted_files = conflictedFiles;
  const mergedBranches = stringArray(outputs.mergedBranches);
  if (mergedBranches) fields.merged_branches = mergedBranches;
  return fields;
}

/**
 * Optional BatchStageRunRow fields read from the run's latest start_task node_run.
 * Both writer paths land the same camelCase keys under node_output.outputs — the
 * flow-step-executor via structured stdout, the task-executor fallback via
 * signal-bridge's readConvergeMergeFields copy. The DTO re-emits them snake_case
 * per the flows IPC casing contract.
 */
function startTaskRowFields(run: NodeRun | undefined): Partial<BatchStageRunRow> {
  if (!run) return {};
  const outputs = (run.nodeOutput as { outputs?: unknown } | null)?.outputs;
  const hasOutputs = outputs !== null && typeof outputs === 'object';
  return {
    start_task_status: run.status,
    ...(hasOutputs ? convergeMergeFields(outputs as Record<string, unknown>) : {}),
  };
}

/** The page and the stage's total in one transaction, one snapshot: a stage run added between the
 * two reads cannot leave the total disagreeing with the page. */
function readStageRunPage(
  db: ReturnType<typeof getDatabase>,
  stageId: string,
  limit: number,
  offset: number,
) {
  return db.transaction((tx) => ({
    rows: tx
      .select({
        id: batchStageRuns.id,
        stageId: batchStageRuns.stageId,
        status: batchStageRuns.status,
        triggerContext: batchStageRuns.triggerContext,
        flowRunId: batchStageRuns.flowRunId,
        flowRunStartedAt: flowRuns.startedAt,
        flowRunCompletedAt: flowRuns.completedAt,
      })
      .from(batchStageRuns)
      .leftJoin(flowRuns, eq(batchStageRuns.flowRunId, flowRuns.id))
      .where(eq(batchStageRuns.stageId, stageId))
      // created_at is second-precision; rowid (insert order) breaks ties so OFFSET pages never
      // repeat or skip a row. Table-qualified: the flow_runs join has a rowid too.
      .orderBy(asc(batchStageRuns.createdAt), asc(drizzleSql`${batchStageRuns}.rowid`))
      .limit(limit)
      .offset(offset)
      .all(),
    total: Number(
      tx
        .select({ c: drizzleSql<number>`count(*)`.as('c') })
        .from(batchStageRuns)
        .where(eq(batchStageRuns.stageId, stageId))
        .get()?.c ?? 0,
    ),
  }));
}

export async function listBatchStageRunsForStage(
  stageId: string,
  opts: ListBatchStageRunsOptions = {},
): Promise<{ runs: BatchStageRunRow[]; total: number }> {
  const db = getDatabase();
  const { rows, total } = readStageRunPage(db, stageId, opts.limit ?? 50, opts.offset ?? 0);

  // Per-row enrichment, keyed by flow run id: read after the snapshot, it cannot change the row count.
  const flowRunIds = rows
    .map((r) => r.flowRunId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const startTaskRuns = await listLatestStartTaskRunsByFlowRunIds(db, flowRunIds);
  const humanWaitRunIds = await listHumanWaitFlowRunIds(db, flowRunIds);
  const chatIds = await resolveBatchRunChatIds(db, rows);

  const runs: BatchStageRunRow[] = rows.map((r, i) => {
    const tc = (r.triggerContext as Record<string, unknown> | null) ?? null;
    // A run-less row keys the lookups with '', which no flow run id matches.
    const runId = r.flowRunId ?? '';
    return {
      id: r.id,
      stage_id: r.stageId,
      status: r.status,
      trigger_context: tc,
      started_at: r.flowRunStartedAt ? r.flowRunStartedAt.toISOString() : null,
      completed_at: r.flowRunCompletedAt ? r.flowRunCompletedAt.toISOString() : null,
      chat_id: chatIds[i],
      needs_input: humanWaitRunIds.has(runId),
      ...startTaskRowFields(startTaskRuns.get(runId)),
    };
  });
  return { runs, total };
}
