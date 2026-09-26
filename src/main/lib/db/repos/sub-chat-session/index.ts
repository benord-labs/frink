import { eq } from 'drizzle-orm';
import log from 'electron-log';
import type { getDatabase } from '../../index';
import { subChats } from '../../schema';

type Db = ReturnType<typeof getDatabase>;
/** Injected so tests observe the line without mocking the log module. */
export type SessionLogger = Pick<typeof log, 'info'>;

/** One line per dropped ('') or swapped handle: sc-2462 lost a session and no writer had logged. */
export function logSessionHandleChange(
  subChatId: string,
  previous: string | null | undefined,
  next: string | null,
  reason: string,
  logger: SessionLogger = log,
): void {
  if (!previous || previous === next) return;
  const outcome = next ? `replaced by ${next}` : 'cleared';
  logger.info(`[sub-chat session] ${subChatId}: ${previous} ${outcome} (${reason})`);
}

/** The standalone handle write (rollback, the tRPC mutation, the executor's early persist). */
export async function writeSubChatSession(
  db: Db,
  subChatId: string,
  sessionId: string,
  reason: string,
  logger: SessionLogger = log,
): Promise<void> {
  // One sync transaction: the id read is the id this UPDATE replaces, never a concurrent writer's.
  const previous = db.transaction(() => {
    const row = db
      .select({ sessionId: subChats.sessionId })
      .from(subChats)
      .where(eq(subChats.id, subChatId))
      .get();
    db.update(subChats)
      .set({ sessionId, updatedAt: new Date() })
      .where(eq(subChats.id, subChatId))
      .run();
    return row?.sessionId;
  });
  logSessionHandleChange(subChatId, previous, sessionId, reason, logger);
}
