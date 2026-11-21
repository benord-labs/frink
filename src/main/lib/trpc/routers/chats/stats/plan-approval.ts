import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type PlanMessageLike, planEpochDecision } from '../../../../../../shared/types';
import { getDatabase } from '../../../../db';
import { findNewestInTranscript } from '../../../../db/repos/sub-chat-messages';
import { subChats as subChatsTable } from '../../../../db/schema';
import { publicProcedure, router } from '../../../index';

/**
 * Phase 1 local-first migration: pending plan-approval scanning runs against local SQLite.
 */
export const planApprovalRouter = router({
  getPendingPlanApprovals: publicProcedure
    .input(z.object({ chatIds: z.array(z.string()).optional() }))
    .query(async ({ input }) => {
      const chatIds = [...new Set(input.chatIds ?? [])];
      if (chatIds.length === 0) return [];

      const db = getDatabase();
      const rows = await db
        .select({ id: subChatsTable.id, chatId: subChatsTable.chatId })
        .from(subChatsTable)
        .where(and(eq(subChatsTable.mode, 'plan'), inArray(subChatsTable.chatId, chatIds)));

      const pendingApprovals: Array<{ subChatId: string; chatId: string }> = [];

      for (const row of rows) {
        if (!row.id || !row.chatId) continue;
        const open = findNewestInTranscript(db, row.id, (message) =>
          planEpochDecision(message as PlanMessageLike),
        );
        if (open === true) pendingApprovals.push({ subChatId: row.id, chatId: row.chatId });
      }

      return pendingApprovals;
    }),
});
