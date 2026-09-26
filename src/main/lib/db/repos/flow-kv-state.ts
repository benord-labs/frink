import { and, eq } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type FlowKvState, flowKvState } from '../schema';

type Db = ReturnType<typeof getDatabase>;

export async function getKv(db: Db, flowId: string, key: string): Promise<FlowKvState | null> {
  const [row] = await db
    .select()
    .from(flowKvState)
    .where(and(eq(flowKvState.flowId, flowId), eq(flowKvState.key, key)))
    .limit(1);
  return row ?? null;
}

/** Upsert by (flow_id, key). Returns the row after write. */
export async function setKv(
  db: Db,
  flowId: string,
  key: string,
  value: unknown,
): Promise<FlowKvState> {
  const [row] = await db
    .insert(flowKvState)
    .values({ flowId, key, value })
    .onConflictDoUpdate({
      target: [flowKvState.flowId, flowKvState.key],
      set: { value, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function deleteKv(db: Db, flowId: string, key: string): Promise<void> {
  await db.delete(flowKvState).where(and(eq(flowKvState.flowId, flowId), eq(flowKvState.key, key)));
}
