import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { hasCurrentUnapprovedPlan, type PlanMessageLike } from '../../../../../../shared/types';
import { getDatabase } from '../../../../db';
import { readTranscripts } from '../../../../db/repos/sub-chat-messages';
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
        .select({ id: subChatsTable.id, chatId: subChatsTable.chatId, mode: subChatsTable.mode })
        .from(subChatsTable)
        .where(and(eq(subChatsTable.mode, 'plan'), inArray(subChatsTable.chatId, chatIds)));
      const transcripts = readTranscripts(
        db,
        rows.map((row) => row.id),
      );

      const pendingApprovals: Array<{ subChatId: string; chatId: string }> = [];

      for (const row of rows) {
        if (!row.id || !row.chatId) continue;
        // SQL filters this before materializing message histories; retain the guard for malformed
        // fixtures and future callers that may provide rows through a different adapter.
        if (row.mode !== 'plan') continue;
        const messages = (transcripts.get(row.id) ?? []) as PlanMessageLike[];
        if (hasCurrentUnapprovedPlan(messages, true)) {
          pendingApprovals.push({ subChatId: row.id, chatId: row.chatId });
        }
      }

      return pendingApprovals;
    }),
});
