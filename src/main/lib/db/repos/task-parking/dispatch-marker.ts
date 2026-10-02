// sc-2775 flow-dispatch delivery stamps on `result`, each a single-key json_set under a status guard
// (like quiet-marker.ts): `dispatchedAt` at claim, `dispatchStartedAt`, `dispatchRedeliveredAt`.

import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { TaskResultRecord } from '../../../../../shared/types/task-result';
import type { getDatabase } from '../..';
import type { Task } from '../../schema';
import { tasks } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

let lastStampMs = 0;

/** A unique, strictly increasing ISO stamp — dispatch generations and start tokens are identities,
 * so two in the same millisecond must still differ (and still parse as a time). */
export function nextDispatchStamp(): string {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return new Date(lastStampMs).toISOString();
}

/** Records that a dispatch's turn started — only on that same dispatch generation (a retry or
 * re-claim since then is a different attempt). Null when that no longer holds. */
export async function setDispatchStartedMarker(
  db: Db,
  taskId: string,
  dispatchedAt: string,
  at = new Date().toISOString(),
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(tasks)
    .set({
      result: drizzleSql`json_set(COALESCE(${tasks.result}, '{}'), '$.dispatchStartedAt', ${at})`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.dispatchedAt') = ${dispatchedAt}`,
      ),
    )
    .returning({ id: tasks.id });
  return row ?? null;
}

/** Undoes the start stamp an aborted turn wrote — only that exact stamp, on that generation. */
export async function clearDispatchStartedMarker(
  db: Db,
  taskId: string,
  dispatchedAt: string,
  startedAt: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(tasks)
    .set({ result: drizzleSql`json_remove(${tasks.result}, '$.dispatchStartedAt')` })
    .where(
      and(
        eq(tasks.id, taskId),
        drizzleSql`json_extract(${tasks.result}, '$.dispatchedAt') = ${dispatchedAt}`,
        drizzleSql`json_extract(${tasks.result}, '$.dispatchStartedAt') = ${startedAt}`,
      ),
    )
    .returning({ id: tasks.id });
  return row ?? null;
}

/** The watchdog's one redelivery: lands only on the exact undelivered dispatch the sweep observed,
 * never twice (overlapping sweeps), never after a re-claim or a started turn. */
export async function setDispatchRedeliveredMarker(
  db: Db,
  taskId: string,
  dispatchedAt: string,
  at = new Date().toISOString(),
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(tasks)
    .set({ result: drizzleSql`json_set(${tasks.result}, '$.dispatchRedeliveredAt', ${at})` })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'running'),
        drizzleSql`json_extract(${tasks.result}, '$.dispatchedAt') = ${dispatchedAt}`,
        drizzleSql`json_extract(${tasks.result}, '$.dispatchStartedAt') IS NULL`,
        // One redelivery per dispatch: overlapping sweeps (setInterval never waits) both see none.
        drizzleSql`json_extract(${tasks.result}, '$.dispatchRedeliveredAt') IS NULL`,
      ),
    )
    .returning({ id: tasks.id });
  return row ?? null;
}

/** Undoes a redelivery that never went out (no window by the time it was sent): that stamp only. */
export async function clearDispatchRedeliveredMarker(
  db: Db,
  taskId: string,
  redeliveredAt: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(tasks)
    .set({ result: drizzleSql`json_remove(${tasks.result}, '$.dispatchRedeliveredAt')` })
    .where(
      and(
        eq(tasks.id, taskId),
        drizzleSql`json_extract(${tasks.result}, '$.dispatchRedeliveredAt') = ${redeliveredAt}`,
      ),
    )
    .returning({ id: tasks.id });
  return row ?? null;
}

function parseStamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** When the current dispatch was sent, while no turn has started for it; null otherwise (and for
 * unstamped rows). Any start counts: the claim replaces `result`, and wall clocks step backwards. */
export function undeliveredDispatchSince(result: Task['result'] | TaskResultRecord): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const dispatchedAt = parseStamp(record.dispatchedAt);
  if (dispatchedAt === null) return null;
  return parseStamp(record.dispatchStartedAt) === null ? dispatchedAt : null;
}

/** True when the task's current dispatch already started a turn (both stamps present). */
export function isDispatchStarted(result: Task['result'] | TaskResultRecord): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return parseStamp(record.dispatchedAt) !== null && undeliveredDispatchSince(result) === null;
}
