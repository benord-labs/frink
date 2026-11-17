// Merges a stamp into `result.turnUsage` with json_patch in one status-guarded UPDATE: no read, so
// neither a concurrent stamp nor another result writer (signal, park, quiet marker) is lost.

import { and, sql as drizzleSql, eq, inArray } from 'drizzle-orm';
import type { TaskStatus } from '../../../../../shared/types/task-status';
import type { StoredTurnUsage } from '../../../../../shared/types/turn-usage';
import type { getDatabase } from '../..';
import { tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** Returns whether the row was written (false: missing, or its status is not expected). */
export async function patchTaskTurnUsage(
  db: Db,
  taskId: string,
  patch: StoredTurnUsage,
  expectStatuses: readonly TaskStatus[],
): Promise<boolean> {
  const [row] = await db
    .update(tasks)
    .set({
      result: drizzleSql`json_patch(COALESCE(${tasks.result}, '{}'), json(${JSON.stringify({ turnUsage: patch })}))`,
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, [...expectStatuses])))
    .returning({ id: tasks.id });
  return row !== undefined;
}
