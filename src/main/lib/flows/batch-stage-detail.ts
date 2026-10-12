/**
 * listBatchStages read query — enrich batch_stages rows with run counts +
 * dependency stage_numbers + latest chat ID. Returns the BatchStageDetail[]
 * shape the renderer's BatchMonitor consumes.
 *
 * Counts:
 *   run_count        all stage_runs for the stage
 *   completed_count  stage_runs.status = 'completed'
 *   failed_count     stage_runs.status = 'failed'
 *   active_count     pending + queued + dispatched
 *   pending_count    the not-yet-dispatched part of active_count
 *   attention_count  started members (queued/dispatched) waiting on a person
 *
 * latest_chat_id   existing chat of the stage's most recently dispatched run that has one
 *                  (start_task chat, else trigger_context.chatId).
 *
 * workstream_ids   distinct trigger_context.workstreamId across stage_runs.
 */

import { sql as drizzleSql, eq } from 'drizzle-orm';
import type { BatchStageDetail } from '../../../shared/types/flows/flow-batch';
import { getDatabase } from '../db';
import { listHumanWaitFlowRunIds } from '../db/repos/node-runs';
import { batchStageRuns, batchStages, flowRuns } from '../db/schema';
import { resolveBatchRunChatIds } from './batch-runs-list';

type DispatchedRun = { stageId: string; runCreatedAt: Date | null; runSeq: number };
type RunChat = { chatId: string; at: number; seq: number };

// created_at is second-precision; the run's rowid (insert order) breaks ties.
const isNewerRun = (a: RunChat, b: RunChat): boolean =>
  a.at > b.at || (a.at === b.at && a.seq > b.seq);

/** Per stage, the chat of the newest dispatched run that has one. One pass, no sort. */
function pickLatestChatByStage(
  rows: DispatchedRun[],
  chatIds: Array<string | null>,
): Map<string, string> {
  const newest = new Map<string, RunChat>();
  rows.forEach((r, i) => {
    const chatId = chatIds[i];
    if (!chatId) return;
    const candidate = { chatId, at: r.runCreatedAt?.getTime() ?? 0, seq: r.runSeq };
    const best = newest.get(r.stageId);
    if (!best || isNewerRun(candidate, best)) newest.set(r.stageId, candidate);
  });
  return new Map([...newest].map(([stageId, run]) => [stageId, run.chatId]));
}

export async function listBatchStageDetail(batchId: string): Promise<BatchStageDetail[]> {
  const db = getDatabase();

  const stages = await db
    .select()
    .from(batchStages)
    .where(eq(batchStages.batchId, batchId))
    .orderBy(batchStages.stageNumber);
  if (stages.length === 0) return [];

  const stageNumberById = new Map(stages.map((s) => [s.id, s.stageNumber]));
  const stageIdFilter = drizzleSql`${batchStageRuns.stageId} IN (${drizzleSql.join(
    stages.map((s) => drizzleSql`${s.id}`),
    drizzleSql`, `,
  )})`;

  // One transaction, one snapshot: the per-stage aggregates and the started rows the attention
  // count is drawn from cannot disagree about a member dispatched or parked between the two reads.
  const { aggRows, chatRows } = db.transaction((tx) => ({
    aggRows: tx
      .select({
        stageId: batchStageRuns.stageId,
        runCount: drizzleSql<number>`count(${batchStageRuns.id})`.as('rc'),
        completedCount:
          drizzleSql<number>`sum(case when ${batchStageRuns.status} = 'completed' then 1 else 0 end)`.as(
            'cc',
          ),
        failedCount:
          drizzleSql<number>`sum(case when ${batchStageRuns.status} = 'failed' then 1 else 0 end)`.as(
            'fc',
          ),
        dispatchedCount:
          drizzleSql<number>`sum(case when ${batchStageRuns.status} in ('queued', 'dispatched') then 1 else 0 end)`.as(
            'rrc',
          ),
        pendingCount:
          drizzleSql<number>`sum(case when ${batchStageRuns.status} = 'pending' then 1 else 0 end)`.as(
            'pc',
          ),
      })
      .from(batchStageRuns)
      .where(stageIdFilter)
      .groupBy(batchStageRuns.stageId)
      .all(),
    // Every stage_run that has a flow_run: feeds the latest chatId and the attention count below.
    chatRows: tx
      .select({
        stageId: batchStageRuns.stageId,
        status: batchStageRuns.status,
        flowRunId: flowRuns.id,
        triggerContext: flowRuns.triggerContext,
        runCreatedAt: flowRuns.createdAt,
        runSeq: drizzleSql<number>`${flowRuns}.rowid`,
      })
      .from(batchStageRuns)
      .innerJoin(flowRuns, eq(batchStageRuns.flowRunId, flowRuns.id))
      .where(stageIdFilter)
      .all(),
  }));
  const aggByStage = new Map(aggRows.map((r) => [r.stageId, r]));

  const latestChatByStage = pickLatestChatByStage(
    chatRows,
    await resolveBatchRunChatIds(db, chatRows),
  );

  // Counted off the same BSR statuses as active_count, so attention_count is always a
  // subset of it: a member whose run waits on a person still occupies its stage slot.
  const startedRows = chatRows.filter((r) => r.status === 'queued' || r.status === 'dispatched');
  const humanWaitRunIds = await listHumanWaitFlowRunIds(
    db,
    startedRows.map((r) => r.flowRunId),
  );
  const attentionByStage = new Map<string, number>();
  for (const r of startedRows) {
    if (!humanWaitRunIds.has(r.flowRunId)) continue;
    attentionByStage.set(r.stageId, (attentionByStage.get(r.stageId) ?? 0) + 1);
  }

  return stages.map((s): BatchStageDetail => {
    const agg = aggByStage.get(s.id);
    const dependsOnStageIds = Array.isArray(s.dependsOnStageIds)
      ? (s.dependsOnStageIds as string[])
      : [];
    const dependsOnStageNumbers = dependsOnStageIds
      .map((id) => stageNumberById.get(id))
      .filter((n): n is number => typeof n === 'number');
    return {
      id: s.id,
      stage_number: s.stageNumber,
      name: s.name,
      status: s.status,
      failure_threshold: s.failureThreshold,
      depends_on_stage_ids: dependsOnStageIds,
      depends_on_stage_numbers: dependsOnStageNumbers,
      run_count: agg ? Number(agg.runCount) : 0,
      completed_count: agg ? Number(agg.completedCount) : 0,
      failed_count: agg ? Number(agg.failedCount) : 0,
      active_count: agg ? Number(agg.dispatchedCount) + Number(agg.pendingCount) : 0,
      pending_count: agg ? Number(agg.pendingCount) : 0,
      attention_count: attentionByStage.get(s.id) ?? 0,
      latest_chat_id: latestChatByStage.get(s.id) ?? null,
      workstream_ids: [],
    };
  });
}
