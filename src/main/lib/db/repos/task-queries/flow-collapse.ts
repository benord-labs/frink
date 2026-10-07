/**
 * Work-queue per-flow collapse — the three shared SQL fragments the list and count paths both use.
 * Extracted from tasks.ts: they are a cohesive read-path unit with no repo dependencies beyond the
 * schema, and keeping them here holds tasks.ts under its size ratchet.
 */

import { and, sql as drizzleSql, eq, type SQL, type SQLWrapper } from 'drizzle-orm';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import type { getDatabase } from '../../index';
import { flowRuns, nodeRuns, tasks } from '../../schema';

/**
 * Work-queue per-flow collapse. A flow runs N agent nodes sequentially, each inserting a task row,
 * but the queue surfaces ONE item per flow run. These three shared SQL fragments do that in the
 * READ path (no write-path change, covers existing rows):
 *
 * - `flowTaskRank(statusCol)` ranks a flow's tasks so the representative is the most actionable /
 *   current step (awaiting-user > failed > running > queued > terminal), NOT merely the latest.
 * - `isFlowRepresentative` keeps exactly one row per flow_run — the top-ranked (NOT EXISTS: no
 *   same-flow task outranks it; ties broken by newest created_at,id). Manual tasks (flow_run_id
 *   NULL) always pass. Lives in WHERE so it collapses BEFORE limit/cursor (pagination stays correct).
 * - `effectiveStatusExpr` reports the flow's LIVE status: a failed/cancelled flow → its run status;
 *   an active flow → the agent's awaiting/running state (so a mid-flow `done` agent reads `running`,
 *   not History). A run-completed flow reads `done` (Ready for review) until the user accepts it —
 *   flow completion is not user confirmation; only raw `completed` (user-accepted) reads `completed`.
 *   Manual tasks pass through their own status. List + counts share it so the badge totals and the
 *   returned cards always agree.
 */
const flowTaskRank = (statusCol: SQLWrapper): SQL => drizzleSql`CASE ${statusCol}
    WHEN 'needs_attention' THEN 8
    WHEN 'failed' THEN 7
    WHEN 'plan_ready' THEN 6
    WHEN 'running' THEN 5
    WHEN 'pending' THEN 4
    WHEN 'done' THEN 3
    WHEN 'completed' THEN 2
    WHEN 'cancelled' THEN 1
    ELSE 0 END`;

/** A retry left this attempt as history: a newer node_run exists for its node + fan-out lane.
 * In-place revivals reuse their node_run, so an attempt the user can still act on never matches.
 * Carry-on and retry refuse on this same rule, so queue and server agree which attempt is current. */
export const isSupersededAttempt = (nodeRunIdCol: SQLWrapper): SQL => drizzleSql`EXISTS (
    SELECT 1 FROM ${nodeRuns} cur
      JOIN ${nodeRuns} newer ON newer.flow_run_id = cur.flow_run_id
       AND newer.node_id = cur.node_id
       AND newer.lane_index IS cur.lane_index
       AND (newer.created_at, newer.rowid) > (cur.created_at, cur.rowid)
     WHERE cur.id = ${nodeRunIdCol})`;

/** Has a retry replaced this task's attempt? A task with no node_run (a manual task) never has. */
export async function isSupersededTask(
  db: ReturnType<typeof getDatabase>,
  taskId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), isSupersededAttempt(tasks.nodeRunId)))
    .limit(1);
  return rows.length > 0;
}

const attemptRank = (statusCol: SQLWrapper, nodeRunIdCol: SQLWrapper): SQL =>
  drizzleSql`CASE WHEN ${isSupersededAttempt(nodeRunIdCol)} THEN 0 ELSE ${flowTaskRank(statusCol)} END`;

export const isFlowRepresentative: SQL = drizzleSql`(${tasks.flowRunId} IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${tasks} t2
    WHERE t2.flow_run_id = ${tasks.flowRunId}
      AND (${attemptRank(drizzleSql`t2.status`, drizzleSql`t2.node_run_id`)}, t2.created_at, t2.id)
        > (${attemptRank(tasks.status, tasks.nodeRunId)}, ${tasks.createdAt}, ${tasks.id})
  ))`;

/**
 * Is this cancelled run a restart INTERRUPTION rather than a deliberate Stop? Scoped to the run's
 * CURRENT attempt — the LATEST task and LATEST node_run — NOT the representative row, and NOT any
 * historical row.
 *
 * Not the representative: it is the highest-RANKED task (flowTaskRank), and `cancelled` ranks lowest,
 * so in a multi-node flow an earlier `done` node wins that slot while the marker sits on the
 * interrupted node — testing the representative's own `result` misses it (the feature's primary case).
 *
 * Not "any historical row": a re-dispatch (`rerunFlowRunFromInterruption`) reuses the same flow_run
 * and mints a NEW task + node_run, leaving the old interrupted-and-marked rows untouched forever. An
 * unscoped EXISTS would then keep reporting `interrupted` even after the user re-runs and then
 * deliberately Stops — misfiling a real Stop into Active with a Resume it can never leave. So we read
 * the marker off the newest row only (created_at, rowid — same latest-wins order getLatestFlowTaskFor*
 * use), which reflects the current attempt: a fresh Stop's newest rows carry no marker → `cancelled`.
 *
 * Both tables are consulted because the two boot sweeps stamp different places: `recoverOrphanedTasks`
 * writes `tasks.result.error` (only agent nodes have a task row), while `recoverOrphanedNodeRuns`
 * writes `node_runs.node_output.error.message` on EVERY still-running node_run — agent and non-agent
 * alike (it filters on `status = 'running'`, not node kind). So a non-agent interruption is visible
 * only in `node_runs`, and an agent interruption can be marked in both; either surviving marker
 * keeps the run `interrupted`.
 */
const hasRestartMarker: SQL = drizzleSql`(
    (SELECT json_extract(mt.result, '$.error')
       FROM ${tasks} mt
      WHERE mt.flow_run_id = ${flowRuns.id}
      ORDER BY mt.created_at DESC, mt.rowid DESC
      LIMIT 1) = ${RESTART_INTERRUPTION_REASON}
    OR (SELECT json_extract(nr.node_output, '$.error.message')
          FROM ${nodeRuns} nr
         WHERE nr.flow_run_id = ${flowRuns.id}
         ORDER BY nr.created_at DESC, nr.rowid DESC
         LIMIT 1) = ${RESTART_INTERRUPTION_REASON}
  )`;

/**
 * `interrupted` is a DERIVED status only — never a value in tasks.status. A run killed by an
 * app/process restart is `cancelled` + the restart marker, which made it indistinguishable from a
 * deliberate Stop and filed it under History as "Task was intentionally stopped" — the opposite of
 * true, and a dead end (the resume affordance lives in the chat, which History does not lead to).
 * Splitting it out lets the work queue carry it as ACTIVE, recoverable work. Ordered BEFORE the
 * plain `cancelled` branch, which is now the deliberate-Stop case only.
 */
export const effectiveStatusExpr: SQL<string> = drizzleSql`CASE
    WHEN ${tasks.flowRunId} IS NULL THEN ${tasks.status}
    WHEN ${flowRuns.status} = 'completed' THEN
      CASE WHEN ${tasks.status} = 'completed' THEN 'completed' ELSE 'done' END
    WHEN ${flowRuns.status} = 'failed' THEN 'failed'
    WHEN ${flowRuns.status} = 'cancelled' AND ${hasRestartMarker}
      THEN 'interrupted'
    WHEN ${flowRuns.status} = 'cancelled' THEN 'cancelled'
    WHEN ${isSupersededAttempt(tasks.nodeRunId)} THEN 'running'
    WHEN ${tasks.status} IN ('needs_attention', 'plan_ready', 'failed') THEN ${tasks.status}
    ELSE 'running' END`;
