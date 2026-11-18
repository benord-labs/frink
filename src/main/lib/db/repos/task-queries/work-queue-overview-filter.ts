import { and, sql as drizzleSql, eq, type SQL } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import {
  flowRunAdmissions,
  flowRuns,
  flows,
  flowVersions,
  nodeRuns,
  projects,
  tasks,
} from '../../schema';
import { effectiveStatusExpr, isFlowRepresentative } from './flow-collapse';

export type WorkQueueSection = 'attention' | 'running';

export const isNotQueuedForAdmission: SQL = drizzleSql`(
  ${tasks.flowRunId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${flowRunAdmissions} wqa
     WHERE wqa.flow_run_id = ${tasks.flowRunId}
       AND wqa.state = 'queued'
  )
)`;

/** One mutually exclusive presentation lane for every task visible on the Overview. */
export const workQueueOverviewSectionExpr: SQL<string> = drizzleSql`CASE
  WHEN ${effectiveStatusExpr} = 'running' THEN 'running'
  WHEN ${effectiveStatusExpr} IN ('plan_ready', 'needs_attention', 'interrupted', 'failed', 'done')
    THEN 'attention'
  ELSE NULL
END`;

/** Paused runs whose Approval step a person can answer now. Mirrors the Runs panel's Approve guard
 *  (shouldShowPausedActions): no queued admission, and the top flow-driving task is not working. */
const awaitingApprovalRunIds: SQL = drizzleSql`SELECT ar.id FROM ${flowRuns} ar
  WHERE ar.status = 'paused'
    AND EXISTS (SELECT 1 FROM ${nodeRuns} an WHERE an.flow_run_id = ar.id
      AND an.block_type = 'approval' AND an.status = 'awaiting_input')
    AND NOT EXISTS (SELECT 1 FROM ${flowRunAdmissions} aq
      WHERE aq.flow_run_id = ar.id AND aq.state = 'queued')
    AND NOT (
      EXISTS (SELECT 1 FROM ${tasks} aw WHERE aw.flow_run_id = ar.id
        AND aw.status IN ('pending', 'running'))
      AND NOT EXISTS (SELECT 1 FROM ${tasks} ah WHERE ah.flow_run_id = ar.id
        AND ah.status IN ('plan_ready', 'needs_attention')))`;

/** A run waiting on its Approval step is shown as an approval, never also as Running. */
export const isNotWaitingOnApproval: SQL = drizzleSql`NOT (
  ${tasks.flowRunId} IS NOT NULL
  AND ${tasks.flowRunId} IN (${awaitingApprovalRunIds})
  AND ${effectiveStatusExpr} = 'running'
)`;

export function getWorkQueueSectionFilter(section: WorkQueueSection): SQL {
  return drizzleSql`(
    ${isFlowRepresentative}
    AND ${isNotQueuedForAdmission}
    AND ${isNotWaitingOnApproval}
    AND ${workQueueOverviewSectionExpr} = ${section}
  )`;
}

/** A lone gate's own message, from the graph version its run executes; blank reads as none. */
const singleGateMessage = drizzleSql<string | null>`CASE WHEN count(*) = 1 THEN nullif(trim(max(
  (SELECT json_extract(gn.value, '$.config.message') FROM json_each(${flowVersions.graph}, '$.nodes') gn
    WHERE json_extract(gn.value, '$.id') = ${nodeRuns.nodeId})
)), '') END`;

/** One item per run waiting on its Approval steps, longest wait first. */
export function listAwaitingApprovals(db: ReturnType<typeof getDatabase>) {
  const waitingSince =
    drizzleSql`min(coalesce(${nodeRuns.completedAt}, ${nodeRuns.createdAt}))`.mapWith(
      nodeRuns.createdAt,
    );
  return db
    .select({
      flowRunId: nodeRuns.flowRunId,
      flowId: flows.id,
      flowName: flows.name,
      projectName: projects.name,
      gateCount: drizzleSql<number>`count(*)`.mapWith(Number),
      // Several gates in one run (Fan Out lanes) are answered from the run, one by one.
      nodeRunId: drizzleSql<string | null>`CASE WHEN count(*) = 1 THEN max(${nodeRuns.id}) END`,
      message: singleGateMessage,
      waitingSince,
    })
    .from(nodeRuns)
    .innerJoin(flowRuns, eq(flowRuns.id, nodeRuns.flowRunId))
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .innerJoin(flows, eq(flows.id, flowVersions.flowId))
    .leftJoin(projects, eq(projects.id, flows.projectId))
    .where(
      and(
        eq(nodeRuns.blockType, 'approval'),
        eq(nodeRuns.status, 'awaiting_input'),
        drizzleSql`${nodeRuns.flowRunId} IN (${awaitingApprovalRunIds})`,
      ),
    )
    .groupBy(nodeRuns.flowRunId)
    .orderBy(waitingSince, nodeRuns.flowRunId)
    .all();
}
