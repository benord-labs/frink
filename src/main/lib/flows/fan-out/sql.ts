// SQL fragments over Fan Out lanes, with no database handle: db repos and pure query builders
// import these without loading the Electron-bound db module.
import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

export const STATE_KEY_PREFIX = '_fanOut:';

/**
 * True when `nodeRunId` ran in a Fan Out item the loop has already moved past: only the item at
 * `currentIndex` is live, and the state row is deleted after the last item. Sequential mode only.
 */
export function isPastFanOutLane(nodeRunId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM node_runs fo_lane
    JOIN node_runs fo_fan ON fo_fan.id = fo_lane.parent_fan_out_node_run_id
    JOIN flow_runs fo_run ON fo_run.id = fo_lane.flow_run_id
    JOIN flow_versions fo_ver ON fo_ver.id = fo_run.flow_version_id
    WHERE fo_lane.id = ${nodeRunId} AND NOT EXISTS (SELECT 1 FROM flow_kv_state fo_kv
      WHERE fo_kv.flow_id = fo_ver.flow_id
        AND fo_kv.key = ${STATE_KEY_PREFIX} || fo_lane.flow_run_id || ':' || fo_fan.node_id
        AND json_extract(fo_kv.value, '$.currentIndex') = fo_lane.lane_index))`;
}

/** The chat a node_run's outputs name, guarded like the chat-link expression indexes. */
const outputChatId = (table: string): SQL<string | null> =>
  sql<string | null>`${sql.raw(
    `(CASE WHEN json_valid(${table}.node_output) THEN json_extract(${table}.node_output, '$.outputs.chatId') END)`,
  )}`;

/** True when `nodeRunId` is a Start Task inside a Fan Out item that opened a chat of its own. */
export function opensFanOutItemChat(nodeRunId: SQLWrapper): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM node_runs fo_item
    WHERE fo_item.id = ${nodeRunId} AND fo_item.parent_fan_out_node_run_id IS NOT NULL
      AND fo_item.block_type = 'start_task'
      AND ${outputChatId('fo_item')} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM node_runs fo_home
        WHERE fo_home.flow_run_id = fo_item.flow_run_id
          AND fo_home.parent_fan_out_node_run_id IS NULL
          AND ${outputChatId('fo_home')} = ${outputChatId('fo_item')}))`;
}

/** Ids of runs that opened a chat per Fan Out item (a Start Task inside the loop). `> ''` rather than
 * IS NOT NULL so SQLite searches the lane index instead of scanning every node_run. */
export const fanOutItemChatRunIds = sql`SELECT fo_any.flow_run_id FROM node_runs fo_any
  WHERE fo_any.parent_fan_out_node_run_id > '' AND ${opensFanOutItemChat(sql.raw('fo_any.id'))}`;
