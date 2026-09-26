import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { flowRunAdmissions, tasks } from '../../schema';
import { effectiveStatusExpr, isFlowRepresentative } from './flow-collapse';

export type WorkQueueSection = 'attention' | 'inbox' | 'running';

/** Canonical wait-mode predicate shared by executor exclusion and Work Queue Inbox reads. */
export const isWaitModeTask: SQL = drizzleSql`(
  ${tasks.status} = 'pending'
  AND lower(COALESCE(
    json_extract(${tasks.triggerContext}, '$._config.startMode'),
    json_extract(${tasks.triggerContext}, '$._config.start_mode'),
    json_extract(${tasks.triggerContext}, '$.Config.startMode'),
    json_extract(${tasks.triggerContext}, '$.Config.start_mode'),
    ''
  )) = 'wait'
)`;

export const isNotQueuedForAdmission: SQL = drizzleSql`(
  ${tasks.flowRunId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${flowRunAdmissions} wqa
     WHERE wqa.flow_run_id = ${tasks.flowRunId}
       AND wqa.state = 'queued'
  )
)`;

/** One mutually exclusive presentation lane for every task visible on the Overview. */
export const workQueueOverviewSectionExpr: SQL<string> = drizzleSql`CASE
  WHEN ${isWaitModeTask} THEN 'inbox'
  WHEN ${effectiveStatusExpr} = 'running' THEN 'running'
  WHEN ${effectiveStatusExpr} IN ('plan_ready', 'needs_attention', 'interrupted', 'failed', 'done')
    THEN 'attention'
  ELSE NULL
END`;

export function getWorkQueueSectionFilter(section: WorkQueueSection): SQL {
  return drizzleSql`(
    ${isFlowRepresentative}
    AND ${isNotQueuedForAdmission}
    AND ${workQueueOverviewSectionExpr} = ${section}
  )`;
}
