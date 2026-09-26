import { desc, eq } from 'drizzle-orm';
import type { getDatabase } from '../index';
import { type BriefingStash, briefingStashes, type NewBriefingStash } from '../schema';

type Db = ReturnType<typeof getDatabase>;

export async function createBriefingStash(db: Db, input: NewBriefingStash): Promise<BriefingStash> {
  const [row] = await db.insert(briefingStashes).values(input).returning();
  return row;
}

export async function listBriefingStashes(db: Db): Promise<BriefingStash[]> {
  return db.select().from(briefingStashes).orderBy(desc(briefingStashes.createdAt));
}

export async function deleteBriefingStash(db: Db, id: string): Promise<void> {
  await db.delete(briefingStashes).where(eq(briefingStashes.id, id));
}
