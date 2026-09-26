import { and, eq, isNull } from 'drizzle-orm';
import log from 'electron-log';
import { claudeCodeCredentials, getDatabase } from '../db';

/** Flag the row for reauth; true only when this call flagged it (it was not flagged yet). */
export function markRowNeedsReauth(rowId: string, reason: string): boolean {
  try {
    const { changes } = getDatabase()
      .update(claudeCodeCredentials)
      .set({ needsReauthAt: new Date() })
      .where(and(eq(claudeCodeCredentials.id, rowId), isNull(claudeCodeCredentials.needsReauthAt)))
      .run();
    if (changes > 0) log.warn(`[credentials] Marked row ${rowId} needs reauth: ${reason}`);
    return changes > 0;
  } catch (error) {
    log.error('[credentials] Failed to mark row needsReauthAt:', error);
    return false;
  }
}

export function markRowResolved(rowId: string, adoptEmail?: string | null): void {
  try {
    const patch: Partial<typeof claudeCodeCredentials.$inferInsert> = {
      lastResolvedFromSourceAt: new Date(),
      needsReauthAt: null,
    };
    if (adoptEmail !== undefined) patch.expectedEmail = adoptEmail;
    getDatabase()
      .update(claudeCodeCredentials)
      .set(patch)
      .where(eq(claudeCodeCredentials.id, rowId))
      .run();
  } catch (error) {
    log.debug('[credentials] Failed to update lastResolvedFromSourceAt:', error);
  }
}
