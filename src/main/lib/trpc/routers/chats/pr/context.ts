import simpleGit from 'simple-git';
import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { publicProcedure, router } from '../../../index';

/** Phase 1 local-first migration: read chat from local SQLite. */
export const prContextRouter = router({
  getPrContext: publicProcedure.input(z.object({ chatId: z.string() })).query(async ({ input }) => {
    const chat = await getChatByIdLocal(getDatabase(), input.chatId);
    if (!chat?.worktreePath) return null;

    try {
      const git = simpleGit(chat.worktreePath);
      const status = await git.status();

      let hasUpstream = false;
      try {
        const tracking = await git.raw(['rev-parse', '--abbrev-ref', '@{upstream}']);
        hasUpstream = !!tracking.trim();
      } catch {
        hasUpstream = false;
      }

      return {
        branch: chat.branch || status.current || 'unknown',
        baseBranch: chat.baseBranch || 'main',
        uncommittedCount: status.files.length,
        hasUpstream,
      };
    } catch {
      return null;
    }
  }),
});
