/**
 * listBatchRuns read query — flow_runs filtered by batchId, optionally further
 * narrowed by status / stageId. Joins batch_stage_runs to filter on stage and
 * to expose chat_id from the linked stage_run's trigger_context.
 *
 * Renderer (BatchReportPanel) expects { runs: BatchRunRow[]; total: number }
 * where BatchRunRow = DbFlowRun + chat_id.
 */

import { and, desc, sql as drizzleSql, eq, isNotNull } from 'drizzle-orm';
import type { BatchRunRow } from '../cloud/flows';
import { getDatabase } from '../db';
import { batchStageRuns, flowRuns } from '../db/schema';
import { toDbFlowRun } from './adapters';

export type ListBatchRunsOptions = {
  status?: string;
  stageId?: string;
  limit?: number;
  offset?: number;
};

export async function listBatchRunsForBatch(
  batchId: string,
  opts: ListBatchRunsOptions = {},
): Promise<{ runs: BatchRunRow[]; total: number }> {
  const db = getDatabase();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const filters = [eq(flowRuns.batchId, batchId), isNotNull(flowRuns.batchId)];
  if (opts.status) filters.push(eq(flowRuns.status, opts.status));

  // base query — when stageId is supplied, INNER JOIN through batch_stage_runs.
  const baseRows = opts.stageId
    ? await db
        .select({
          run: flowRuns,
          stageRunTriggerContext: batchStageRuns.triggerContext,
        })
        .from(flowRuns)
        .innerJoin(batchStageRuns, eq(batchStageRuns.flowRunId, flowRuns.id))
        .where(and(...filters, eq(batchStageRuns.stageId, opts.stageId)))
        .orderBy(desc(flowRuns.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select({
          run: flowRuns,
          stageRunTriggerContext: drizzleSql<unknown>`NULL`.as('stage_run_trigger_context'),
        })
        .from(flowRuns)
        .where(and(...filters))
        .orderBy(desc(flowRuns.createdAt))
        .limit(limit)
        .offset(offset);

  const totalRows = opts.stageId
    ? await db
        .select({ c: drizzleSql<number>`count(*)`.as('c') })
        .from(flowRuns)
        .innerJoin(batchStageRuns, eq(batchStageRuns.flowRunId, flowRuns.id))
        .where(and(...filters, eq(batchStageRuns.stageId, opts.stageId)))
    : await db
        .select({ c: drizzleSql<number>`count(*)`.as('c') })
        .from(flowRuns)
        .where(and(...filters));

  const total = Number(totalRows[0]?.c ?? 0);

  const runs: BatchRunRow[] = baseRows.map((r) => {
    const tc = (r.stageRunTriggerContext as Record<string, unknown> | null) ?? null;
    const chatId = tc && typeof tc.chatId === 'string' && tc.chatId.length > 0 ? tc.chatId : null;
    return { ...toDbFlowRun(r.run), chat_id: chatId };
  });
  return { runs, total };
}
