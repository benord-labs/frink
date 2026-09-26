import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { getWorktreeDiff } from '../../../../git';
import { publicProcedure, router } from '../../../index';

/** Phase 1 local-first migration: read chat from local SQLite. */
export const diffRouter = router({
  getDiff: publicProcedure.input(z.object({ chatId: z.string() })).query(async ({ input }) => {
    const chat = await getChatByIdLocal(getDatabase(), input.chatId);

    if (!chat?.worktreePath) {
      return { diff: null, error: 'No worktree path' };
    }

    const result = await getWorktreeDiff(chat.worktreePath, chat.baseBranch ?? undefined);
    if (!result.success) {
      return { diff: null, error: result.error };
    }
    return { diff: result.diff || '' };
  }),
});
