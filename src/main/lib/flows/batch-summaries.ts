/**
 * listBatches read query — aggregates flow_runs by batch_id for one flow.
 *
 * Returns the BatchSummary[] shape the renderer's BatchMonitor + FlowRunHistoryPanel
 * consume. Counts are derived from flow_runs.status across every run with the
 * same batch_id; first/last activity from min/max created_at.
 */

import { and, desc, sql as drizzleSql, eq, isNotNull } from 'drizzle-orm';
import type { SidebarBatchGroup } from '../../../shared/types/flows/sidebar-batch-group';
import type { BatchSummary } from '../../../shared/types/flows/flow-batch';
import { getDatabase } from '../db';
import { CHAT_LINK_SOURCES } from '../db/repos/flow-runs';
import { chats, flowRuns, flows, flowVersions, nodeRuns, tasks } from '../db/schema';

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

/**
 * Sidebar batch-group summaries — aggregates local flow_runs by batch_id across ALL flows
 * (the sidebar version of `listBatchSummaries`, which is scoped to one flow). Local-first
 * replacement for the cloud `getBatchGroupsForUser`: flow_runs are local-only, so the sidebar
 * reads them from local SQLite. Joins flow_versions→flows
 * for the display name; no user filter (single-user local DB, parity with the chats it groups,
 * which are also unfiltered). Counts only runs with a live chat (`RUN_HAS_LIVE_CHAT`). Returns up to
 * `limit` most-recently-active batches.
 */
export async function listSidebarBatchGroups(
  db: ReturnType<typeof getDatabase>,
  limit = 20,
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
    .where(and(isNotNull(flowRuns.batchId), RUN_HAS_LIVE_CHAT))
    .groupBy(flowRuns.batchId)
    .orderBy(desc(drizzleSql`max(${flowRuns.createdAt})`))
    .limit(limit);

  return rows.flatMap((r) => {
    if (!r.batchId) return [];
    const group: SidebarBatchGroup = {
      batch_id: r.batchId,
      flow_name: r.flowName,
      run_count: Number(r.runCount),
      completed_count: Number(r.completedCount),
      failed_count: Number(r.failedCount),
      running_count: Number(r.runningCount),
      first_run_at: r.firstAt ? new Date(Number(r.firstAt) * 1000).toISOString() : null,
      last_activity_at: r.lastAt ? new Date(Number(r.lastAt) * 1000).toISOString() : null,
    };
    return [group];
  });
}
