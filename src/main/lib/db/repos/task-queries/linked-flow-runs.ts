import { and, eq, inArray, not, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { type AnySQLiteColumn, union } from 'drizzle-orm/sqlite-core';
import { isPastFanOutLane } from '../../../flows/fan-out-state';
import type { getDatabase } from '../../index';
import { flowRuns, nodeRuns, tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

type ChatLinkPath = '$.chatId' | '$.subChatId' | '$.outputs.chatId' | '$.outputs.subChatId';

/** A chat or sub-chat id from a JSON chat↔run link column. The drizzle/0110 expression indexes apply
 * only when a query repeats this exact expression, so the path is inlined, never bound. */
export function chatLinkId(column: AnySQLiteColumn, path: ChatLinkPath): SQL<string | null> {
  return sql<
    string | null
  >`(CASE WHEN json_valid(${column}) THEN json_extract(${column}, ${sql.raw(`'${path}'`)}) END)`;
}

/** With `currentLanesOnly`, a link made inside a finished Fan Out item no longer counts. */
function currentLaneFilter(currentLanesOnly: boolean, nodeRunId: SQLWrapper): SQL | undefined {
  return currentLanesOnly ? not(isPastFanOutLane(nodeRunId)) : undefined;
}

/** Flow runs linked through the trigger, a node's outputs, or a task's result (a branch chat's only
 * link), as a UNION of index lookups. `ids` may be an outer column for correlated projections. */
export function linkedFlowRunIds(
  db: Db,
  key: 'chatId' | 'subChatId',
  ids: string[] | string | SQL,
  { currentLanesOnly = false }: { currentLanesOnly?: boolean } = {},
) {
  const matches = (expr: SQL<string | null>) =>
    Array.isArray(ids) ? inArray(expr, ids) : eq(expr, ids);
  return union(
    db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(matches(chatLinkId(flowRuns.triggerContext, `$.${key}`))),
    db
      .select({ id: sql<string>`${nodeRuns.flowRunId}` })
      .from(nodeRuns)
      .where(
        and(
          matches(chatLinkId(nodeRuns.nodeOutput, `$.outputs.${key}`)),
          currentLaneFilter(currentLanesOnly, nodeRuns.id),
        ),
      ),
    db
      .select({ id: sql<string>`${tasks.flowRunId}` })
      .from(tasks)
      .where(
        and(
          matches(chatLinkId(tasks.result, `$.${key}`)),
          currentLaneFilter(currentLanesOnly, tasks.nodeRunId),
        ),
      ),
  );
}
