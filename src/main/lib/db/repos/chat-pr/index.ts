import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { getDatabase } from '../../index';
import { chats } from '../../schema';

type Db = ReturnType<typeof getDatabase>;

/**
 * Atomic "set PR link if it differs": one conditional UPDATE, so concurrent finalizations cannot
 * interleave a read and a write, and an unchanged link never bumps `updatedAt` (sidebar order).
 */
export async function setChatPrIfChanged(
  db: Db,
  id: string,
  pr: { prUrl: string; prNumber: number },
): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({ ...pr, updatedAt: new Date() })
    .where(and(eq(chats.id, id), or(isNull(chats.prUrl), ne(chats.prUrl, pr.prUrl))))
    .returning({ id: chats.id });
  return rows.length > 0;
}
