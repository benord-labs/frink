import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { fetchGitHubPRStatus } from '../../../../git';
import { publicProcedure, router } from '../../../index';

/** Phase 1 local-first migration: read chat from local SQLite. */
export const prStatusRouter = router({
  getPrStatus: publicProcedure.input(z.object({ chatId: z.string() })).query(async ({ input }) => {
    const chat = await getChatByIdLocal(getDatabase(), input.chatId);
    if (!chat?.worktreePath) return null;
    return await fetchGitHubPRStatus(chat.worktreePath);
  }),
});
