/**
 * listBatches read query — aggregates flow_runs by batch_id for one flow.
 *
 * Returns the BatchSummary[] shape the renderer's BatchMonitor + FlowRunHistoryPanel
 * consume. Counts are derived from flow_runs.status across every run with the
 * same batch_id; first/last activity from min/max created_at.
 */

import {
  and,
  desc,
  sql as drizzleSql,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQLWrapper,
} from 'drizzle-orm';
import type { SidebarBatchGroup } from '../../../shared/types/flows/sidebar-batch-group';
import type { BatchSummary } from '../../../shared/types/flows/flow-batch';
import { getDatabase } from '../db';
import { CHAT_LINK_SOURCES } from '../db/repos/flow-runs';
import { isSupersededAttempt } from '../db/repos/task-queries/flow-collapse';
import { chatLinkId } from '../db/repos/task-queries/linked-flow-runs';
import { chats, flowRuns, flows, flowVersions, nodeRuns, tasks } from '../db/schema';
import { isPastFanOutLane, opensFanOutItemChat } from './fan-out/sql';

const { triggerChatId, nodeChatId, taskChatId } = CHAT_LINK_SOURCES;

/** A run counts in the sidebar header only while a chat it links to is live (sidebar-batch-group-rows). */
const RUN_HAS_LIVE_CHAT = drizzleSql`EXISTS (SELECT 1 FROM ${chats} WHERE ${chats.archivedAt} IS NULL AND (
  ${chats.id} = ${triggerChatId}
  OR ${chats.id} IN (SELECT ${nodeChatId} FROM ${nodeRuns} WHERE ${nodeRuns.flowRunId} = ${flowRuns.id})
  OR ${chats.id} IN (SELECT ${taskChatId} FROM ${tasks} WHERE ${tasks.flowRunId} = ${flowRuns.id})))`;

export async function listBatchSummaries(flowId: string, limit: number): Promise<BatchSummary[]> {
  const db = getDatabase();

  // Find every flow_version for this flow, then aggregate flow_runs grouped by batch_id.
  const rows = await db
    .select({
      batchId: flowRuns.batchId,
      runCount: drizzleSql<number>`count(${flowRuns.id})`.as('run_count'),
      completedCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'completed' then 1 else 0 end)`.as(
          'completed_count',
        ),
      failedCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'failed' then 1 else 0 end)`.as(
          'failed_count',
        ),
      cancelledCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'cancelled' then 1 else 0 end)`.as(
          'cancelled_count',
        ),
      runningCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'running' then 1 else 0 end)`.as(
          'running_count',
        ),
      pausedCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'paused' then 1 else 0 end)`.as(
          'paused_count',
        ),
      pendingCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'pending' then 1 else 0 end)`.as(
          'pending_count',
        ),
      firstAt: drizzleSql<number | null>`min(${flowRuns.createdAt})`.as('first_at'),
      lastAt: drizzleSql<number | null>`max(${flowRuns.createdAt})`.as('last_at'),
    })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowRuns.flowVersionId, flowVersions.id))
    .where(and(eq(flowVersions.flowId, flowId), isNotNull(flowRuns.batchId)))
    .groupBy(flowRuns.batchId)
    .orderBy(desc(drizzleSql`max(${flowRuns.createdAt})`))
    .limit(limit);

  return rows.flatMap((r) => {
    if (!r.batchId) return [];
    const erroredCount = Number(r.failedCount) + Number(r.cancelledCount);
    const activeCount = Number(r.runningCount) + Number(r.pausedCount) + Number(r.pendingCount);
    const summary: BatchSummary = {
      batch_id: r.batchId,
      run_count: Number(r.runCount),
      completed_count: Number(r.completedCount),
      failed_count: Number(r.failedCount),
      errored_count: erroredCount,
      running_count: Number(r.runningCount),
      active_count: activeCount,
      first_run_at: r.firstAt ? new Date(Number(r.firstAt) * 1000).toISOString() : null,
      last_activity_at: r.lastAt ? new Date(Number(r.lastAt) * 1000).toISOString() : null,
    };
    return [summary];
  });
}

/** Summaries for the sidebar groups on screen: a batch aggregates its runs that still have a live
 * chat (`RUN_HAS_LIVE_CHAT`), a Fan Out run aggregates its items. */
export async function listSidebarBatchGroups(
  db: ReturnType<typeof getDatabase>,
  groupIds: string[],
): Promise<SidebarBatchGroup[]> {
  if (groupIds.length === 0) return [];
  return [
    ...(await listBatchGroupRows(db, groupIds)),
    ...(await listFanOutRunGroupRows(db, groupIds)),
  ];
}

const toIso = (seconds: number | null): string | null =>
  seconds ? new Date(Number(seconds) * 1000).toISOString() : null;

async function listBatchGroupRows(
  db: ReturnType<typeof getDatabase>,
  batchIds: string[],
): Promise<SidebarBatchGroup[]> {
  const rows = await db
    .select({
      batchId: flowRuns.batchId,
      // A batch_id is a per-batch randomUUID (graph.settings.currentBatchId), so every run sharing it
      // belongs to ONE flow → every joined flows.name is identical and min() picks that single name
      // deterministically. Grouping by batchId alone is correct (the renderer keys its map on batch_id;
      // splitting by flowId would emit duplicate batch_id rows that collide in that map).
      flowName: drizzleSql<string>`min(${flows.name})`.as('flow_name'),
      runCount: drizzleSql<number>`count(${flowRuns.id})`.as('run_count'),
      completedCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'completed' then 1 else 0 end)`.as(
          'completed_count',
        ),
      failedCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'failed' then 1 else 0 end)`.as(
          'failed_count',
        ),
      runningCount:
        drizzleSql<number>`sum(case when ${flowRuns.status} = 'running' then 1 else 0 end)`.as(
          'running_count',
        ),
      firstAt: drizzleSql<number | null>`min(${flowRuns.createdAt})`.as('first_at'),
      lastAt: drizzleSql<number | null>`max(${flowRuns.createdAt})`.as('last_at'),
    })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowRuns.flowVersionId, flowVersions.id))
    .innerJoin(flows, eq(flowVersions.flowId, flows.id))
    .where(and(inArray(flowRuns.batchId, batchIds), RUN_HAS_LIVE_CHAT))
    .groupBy(flowRuns.batchId);

  return rows.flatMap((r) => {
    if (!r.batchId) return [];
    const group: SidebarBatchGroup = {
      batch_id: r.batchId,
      kind: 'batch',
      flow_name: r.flowName,
      run_count: Number(r.runCount),
      completed_count: Number(r.completedCount),
      failed_count: Number(r.failedCount),
      running_count: Number(r.runningCount),
      first_run_at: toIso(r.firstAt),
      last_activity_at: toIso(r.lastAt),
    };
    return [group];
  });
}

/** The Fan Out item `nodeRunId` ran in failed on its latest attempt (a retried failure is history). */
const failedItem = (nodeRunId: SQLWrapper) => drizzleSql`EXISTS (SELECT 1 FROM node_runs fo_step
  JOIN node_runs fo_try ON fo_try.flow_run_id = fo_step.flow_run_id
    AND fo_try.parent_fan_out_node_run_id = fo_step.parent_fan_out_node_run_id
    AND fo_try.lane_index = fo_step.lane_index
  WHERE fo_step.id = ${nodeRunId} AND fo_try.status = 'failed'
    AND NOT ${isSupersededAttempt(drizzleSql.raw('fo_try.id'))})`;

/** One group per Fan Out run, counting the items whose chat is still listed. */
async function listFanOutRunGroupRows(
  db: ReturnType<typeof getDatabase>,
  runIds: string[],
): Promise<SidebarBatchGroup[]> {
  const rows = await db
    .select({
      runId: flowRuns.id,
      flowName: drizzleSql<string>`min(${flows.name})`,
      live: drizzleSql<number>`max(${flowRuns.status} in ('pending', 'running', 'paused'))`,
      createdAt: drizzleSql<number | null>`min(${flowRuns.createdAt})`,
      items: drizzleSql<number>`count(DISTINCT ${chats.id})`,
      finished: drizzleSql<number>`count(DISTINCT CASE WHEN ${isPastFanOutLane(nodeRuns.id)} THEN ${chats.id} END)`,
      failed: drizzleSql<number>`count(DISTINCT CASE WHEN ${failedItem(nodeRuns.id)} THEN ${chats.id} END)`,
    })
    .from(nodeRuns)
    .innerJoin(flowRuns, eq(flowRuns.id, nodeRuns.flowRunId))
    .innerJoin(flowVersions, eq(flowRuns.flowVersionId, flowVersions.id))
    .innerJoin(flows, eq(flowVersions.flowId, flows.id))
    .innerJoin(
      chats,
      and(
        eq(chats.id, chatLinkId(nodeRuns.nodeOutput, '$.outputs.chatId')),
        isNull(chats.archivedAt),
      ),
    )
    .where(
      and(inArray(flowRuns.id, runIds), isNull(flowRuns.batchId), opensFanOutItemChat(nodeRuns.id)),
    )
    .groupBy(flowRuns.id);

  return rows.map((r) => ({
    batch_id: r.runId,
    kind: 'run',
    flow_name: r.flowName,
    run_count: Number(r.items),
    completed_count: Number(r.finished),
    failed_count: Number(r.failed),
    running_count: Number(r.live),
    first_run_at: toIso(r.createdAt),
    last_activity_at: toIso(r.createdAt),
  }));
}
