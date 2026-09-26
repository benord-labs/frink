import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { hasCurrentUnapprovedPlan, type PlanMessageLike } from '../../../../../../shared/types';
import { getDatabase } from '../../../../db';
import { safeParseMessages } from '../../../../db/repos/sub-chats';
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

      const rows = await getDatabase()
        .select({
          id: subChatsTable.id,
          chatId: subChatsTable.chatId,
          mode: subChatsTable.mode,
          messages: subChatsTable.messages,
        })
        .from(subChatsTable)
        .where(and(eq(subChatsTable.mode, 'plan'), inArray(subChatsTable.chatId, chatIds)));

      const pendingApprovals: Array<{ subChatId: string; chatId: string }> = [];

      for (const row of rows) {
        if (!row.id || !row.chatId) continue;
        // SQL filters this before materializing message histories; retain the guard for malformed
        // fixtures and future callers that may provide rows through a different adapter.
        if (row.mode !== 'plan') continue;
        if (!row.messages) continue;

        try {
          // Phase 1.5 fix C: defensive parse via the repo helper so a corrupt
          // sub-chat row no longer aborts the whole pending-approval scan.
          const messages = safeParseMessages(row.id, row.messages) as PlanMessageLike[];

          if (hasCurrentUnapprovedPlan(messages, true)) {
            pendingApprovals.push({
              subChatId: row.id,
              chatId: row.chatId,
            });
          }
        } catch {
          // Skip invalid data
        }
      }

      return pendingApprovals;
    }),
});
