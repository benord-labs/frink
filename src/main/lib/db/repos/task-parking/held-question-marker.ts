/**
 * Durable trace of an AskUserQuestion still held in memory, so boot can park it after a crash.
 *
 * Result-only (status stays `running`, no `agentSignal`) so nothing advances mid-turn.
 */

import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { TaskSignalPayload } from '../../../../../shared/types/task-signal';
import type { getDatabase } from '../..';
import type { Task } from '../../schema';
import { tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/** JSON path of one hold's entry; the id is quoted so any provider id is a single path member. */
const markerPath = (toolUseId: string): string => `$.heldQuestions.${JSON.stringify(toolUseId)}`;

/** Records a held question on a running task. Returns the updated row, or null (not running). */
export async function setHeldQuestionMarker(
  db: Db,
  taskId: string,
  toolUseId: string,
  signal: TaskSignalPayload,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({
      result: drizzleSql`json_set(COALESCE(${tasks.result}, '{}'), ${markerPath(toolUseId)}, json(${JSON.stringify(signal)}))`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
    .returning();
  return row ?? null;
}

/**
 * Removes one hold's entry, any status: a park or cancel that already stripped the key makes this a
 * no-op. The emptied container is dropped too, so a "has a held question" read stays a key check.
 */
export async function removeHeldQuestionMarker(
  db: Db,
  taskId: string,
  toolUseId: string,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({
      result: drizzleSql`CASE
        WHEN json_type(json_remove(${tasks.result}, ${markerPath(toolUseId)}), '$.heldQuestions') = 'object'
          AND json_extract(json_remove(${tasks.result}, ${markerPath(toolUseId)}), '$.heldQuestions') = '{}'
        THEN json_remove(${tasks.result}, '$.heldQuestions')
        ELSE json_remove(${tasks.result}, ${markerPath(toolUseId)})
      END`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        drizzleSql`json_extract(${tasks.result}, ${markerPath(toolUseId)}) IS NOT NULL`,
      ),
    )
    .returning();
  return row ?? null;
}

/** Running tasks still carrying a held question — at boot, the holds a dead process left open. */
export function listTasksHoldingQuestions(db: Db): Task[] {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'running'),
        drizzleSql`json_type(${tasks.result}, '$.heldQuestions') = 'object'`,
      ),
    )
    .all();
}
