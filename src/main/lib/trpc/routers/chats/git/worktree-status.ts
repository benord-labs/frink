import simpleGit from 'simple-git';
import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { publicProcedure, router } from '../../../index';

/** Phase 1 local-first migration: read chat from local SQLite. */
export const worktreeStatusRouter = router({
  getWorktreeStatus: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      const chat = await getChatByIdLocal(getDatabase(), input.chatId);

      if (!chat?.worktreePath || !chat?.branch) {
        return { hasWorktree: false, uncommittedCount: 0 };
      }

      try {
        const git = simpleGit(chat.worktreePath);
        const status = await git.status();
        return { hasWorktree: true, uncommittedCount: status.files.length };
      } catch {
        return { hasWorktree: false, uncommittedCount: 0 };
      }
    }),
});
