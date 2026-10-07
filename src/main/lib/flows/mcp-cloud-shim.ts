/**
 * Flow reads and writes for the MCP flows tools, adapting local SQLite rows to the DTO shape.
 * Operations with no local equivalent (fan-out broadcast) throw rather than silently noop.
 */

import { TRPCError } from '@trpc/server';
import { getDatabase } from '../db';
import { listBatchPlanTemplates as listBatchPlanTemplatesLocal } from '../db/repos/batch-plan-templates';
import { createBatchStageRun } from '../db/repos/batch-stage-runs';
import {
  insertBatchStagesWithRuns,
  listStagesForBatch,
  type NewStageWithRuns,
} from '../db/repos/batch-stages';
import { getFlowRun as getFlowRunRow, listFlowRunsForFlow } from '../db/repos/flow-runs';
import {
  createFlowVersion as createFlowVersionLocal,
  getLatestVersion,
  getVersion,
} from '../db/repos/flow-versions';
import {
  createFlow as createFlowLocal,
  getFlowById,
  listFlows as listFlowsLocal,
  updateFlow as updateFlowLocal,
} from '../db/repos/flows';
import { listNodeRunsForFlowRun } from '../db/repos/node-runs';
import {
  toDbBatchPlanTemplate,
  toDbFlow,
  toDbFlowRun,
  toDbFlowRunSnapshot,
  toDbFlowRunWithNodeRuns,
  toDbFlowVersion,
  toDbFlowWithLatestVersion,
} from './adapters';
import { flowRunAdmissionSnapshotsForRuns } from './admission/visibility';
import { startFlowBatchLocal } from './batch-dispatch';
import { listBatchRunsForBatch } from './batch-runs-list';
import { listBatchStageDetail } from './batch-stage-detail';
import type { startFlowRun as engineStartFlowRun } from './start';
import { startFlowRun as startFlowRunInternal } from './start';

// ============ flows CRUD ============

export async function listFlows(projectId?: string | null) {
  const db = getDatabase();
  const rows = await listFlowsLocal(db, projectId);
  return Promise.all(
    rows.map(async (row) => {
      const version = await getLatestVersion(db, row.id);
      const graph =
        version && typeof version.graph === 'object' && version.graph !== null
          ? (version.graph as { nodes?: { blockType: string }[] })
          : null;
      return toDbFlow(row, {
        nodeCount: graph?.nodes?.length ?? null,
        triggerType: graph?.nodes?.[0]?.blockType ?? null,
      });
    }),
  );
}

export async function getFlow(id: string) {
  const db = getDatabase();
  const row = await getFlowById(db, id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
  const version = await getLatestVersion(db, row.id);
  const graph =
    version && typeof version.graph === 'object' && version.graph !== null
      ? (version.graph as { nodes?: { blockType: string }[] })
      : null;
  return toDbFlowWithLatestVersion(row, version, {
    nodeCount: graph?.nodes?.length ?? null,
    triggerType: graph?.nodes?.[0]?.blockType ?? null,
  });
}

export async function createFlow(input: {
  name: string;
  description?: string | null;
  projectId?: string | null;
}) {
  const db = getDatabase();
  const row = await createFlowLocal(db, {
    name: input.name,
    description: input.description ?? null,
    projectId: input.projectId ?? null,
  });
  return toDbFlow(row);
}

export async function deleteFlow(id: string): Promise<void> {
  const { deleteFlow: deleteFlowLocal } = await import('./deletion');
  if (!(await deleteFlowLocal(id))) throw new Error(`Flow ${id} not found`);
}

/**
 * Turn on a flow's standing agent-run grant. Same write the Flow settings
 * toggle performs, so the flag stays the one source of truth for that right.
 */
export async function updateFlow(id: string, patch: { agentInvocable: boolean }): Promise<void> {
  await updateFlowLocal(getDatabase(), id, patch);
}

export async function createFlowVersion(
  flowId: string,
  input: { graph: unknown; expectedVersionNumber?: number },
) {
  const db = getDatabase();
  const row = await createFlowVersionLocal(db, {
    flowId,
    graph: input.graph,
    expectedVersionNumber: input.expectedVersionNumber,
  });
  return toDbFlowVersion(row);
}

// ============ flow runs ============

export async function listFlowRuns(flowId: string, limit = 20) {
  const db = getDatabase();
  const rows = await listFlowRunsForFlow(db, flowId, limit);
  return rows.map((row) => toDbFlowRun(row));
}

export async function getFlowRun(id: string) {
  const db = getDatabase();
  const run = await getFlowRunRow(db, id);
  if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
  const nodeRuns = await listNodeRunsForFlowRun(db, run.id);
  const version = await getVersion(db, run.flowVersionId);
  return toDbFlowRunWithNodeRuns(run, nodeRuns, version?.graph ?? null);
}

export async function startFlowRun(
  flowId: string,
  input: {
    triggerContext?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  } = {},
): Promise<ReturnType<typeof toDbFlowRunSnapshot>> {
  const args: Parameters<typeof engineStartFlowRun>[0] = {
    flowId,
    triggerContext: input.triggerContext ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
  const { run } = await startFlowRunInternal(args);
  const snapshot = flowRunAdmissionSnapshotsForRuns(getDatabase(), [run.id]).get(run.id);
  return toDbFlowRunSnapshot(run, snapshot);
}

// ============ batches ============

export type BatchStageInput = NewStageWithRuns;

export async function listFlowBatchRuns(
  _flowId: string,
  batchId: string,
  opts: { status?: string; limit?: number; offset?: number; stageId?: string } = {},
) {
  return listBatchRunsForBatch(batchId, opts);
}

export async function listFlowBatchStages(_flowId: string, batchId: string) {
  const stages = await listBatchStageDetail(batchId);
  return { stages };
}

/**
 * Bulk insert batch_stages + their batch_stage_runs atomically (all or nothing).
 * Resolves dependsOn (stageNumbers) → dependsOnStageIds, including stages from earlier calls.
 */
export async function defineFlowBatchStages(
  _flowId: string,
  batchId: string,
  stages: BatchStageInput[],
): Promise<{
  stages: Array<{
    id: string;
    stageNumber: number;
    name: string | null;
    status: string;
    runCount: number;
    dependsOnStageNumbers?: number[];
  }>;
  rootStageCount: number;
  maxDepth: number;
}> {
  const stageIdByNumber = insertBatchStagesWithRuns(getDatabase(), batchId, stages);

  const rootStageCount = stages.filter((s) => (s.dependsOn ?? []).length === 0).length;
  return {
    stages: stages.map((s) => {
      const id = stageIdByNumber.get(s.stageNumber);
      return {
        id: id ?? '',
        stageNumber: s.stageNumber,
        name: s.name ?? null,
        status: 'pending',
        runCount: s.runs.length,
        dependsOnStageNumbers: s.dependsOn,
      };
    }),
    rootStageCount,
    // maxDepth is informational; cheap upper bound for v1 — refine if needed
    maxDepth: stages.length,
  };
}

/**
 * Append more runs to an existing stage. Cloud signature is
 * (flowId, stageNumber, batchId, runs); we match it 1:1.
 */
export async function addStageRuns(
  _flowId: string,
  stageNumber: number,
  batchId: string,
  runs: Array<{ triggerContext?: Record<string, unknown> }>,
): Promise<{
  added: Array<{ runId: string; index: number }>;
  failed: Array<{ index: number; error: string }>;
}> {
  const db = getDatabase();
  const stages = await listStagesForBatch(db, batchId);
  const stage = stages.find((s) => s.stageNumber === stageNumber);
  if (!stage) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Batch ${batchId} has no stage with number ${stageNumber}`,
    });
  }
  const added: Array<{ runId: string; index: number }> = [];
  const failed: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < runs.length; i += 1) {
    try {
      const inserted = await createBatchStageRun(db, {
        stageId: stage.id,
        triggerContext: runs[i].triggerContext ?? null,
        status: 'pending',
      });
      added.push({ runId: inserted.id, index: i });
    } catch (err) {
      failed.push({ index: i, error: err instanceof Error ? err.message : 'insert failed' });
    }
  }
  return { added, failed };
}

/** Real batch dispatch — promote root stages and create flow_runs for their BSRs. */
export async function startFlowBatch(flowId: string, batchId: string) {
  return startFlowBatchLocal(flowId, batchId);
}

/**
 * Fan-out chat message across batch's flow_runs. Deferred — needs the
 * chat-reply infra to deliver per-run messages. For now throw a clear error
 * rather than silently no-op, so MCP tool callers know.
 */
export async function sendBatchMessage(
  _flowId: string,
  _batchId: string,
  _message: string,
  _flowRunId?: string,
): Promise<{ success: boolean; queued: number; delivered: number; message: string }> {
  throw new TRPCError({
    code: 'NOT_IMPLEMENTED',
    message:
      'sendBatchMessage local impl: per-run chat-reply fan-out not wired yet — open issue if you need this for an MCP-driven flow',
  });
}

// ============ batch plan templates ============

export async function listBatchPlanTemplates(_flowId?: string) {
  const rows = await listBatchPlanTemplatesLocal(getDatabase());
  return rows.map(toDbBatchPlanTemplate);
}

// ============ Re-export DTO types so flows-tools/index.ts gets them from one place ============

export type { DbFlowRun, DbFlowRunWithNodeRuns } from '../../../shared/types/flow-run';

export type BatchRunRow = import('../cloud/flows').BatchRunRow;
