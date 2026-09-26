import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../../db';
import {
  findChatByWorktree as findChatByWorktreeLocal,
  getChatById as getChatByIdLocal,
  updateChat as updateChatLocal,
} from '../../../../db/repos/chats';
import { gitCache } from '../../../../git/cache';
import { detectBaseBranch, getCurrentBranch, getDefaultBranch } from '../../../../git/worktree';
import { publicProcedure, router } from '../../../index';

/**
 * Phase 1 local-first migration: switch a chat's active worktree against local SQLite.
 * Atomicity is provided by per-chat updateChat (single UPDATE).
 */
export const switchWorktreeRouter = router({
  switchWorktree: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        worktreePath: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const chat = await getChatByIdLocal(db, input.chatId);
      if (!chat) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
      }

      const oldWorktreePath = chat.worktreePath;

      if (oldWorktreePath === input.worktreePath) {
        return {
          success: true,
          worktreePath: chat.worktreePath,
          branch: chat.branch,
          baseBranch: chat.baseBranch,
        };
      }

      // Reject if target is already owned by a different chat (forks share, but explicit
      // switch must not silently re-target).
      const ownerChat = await findChatByWorktreeLocal(db, input.worktreePath);
      if (ownerChat && ownerChat.id !== input.chatId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `This worktree is already used by another chat: "${ownerChat.name ?? ownerChat.id}"`,
        });
      }

      let branch: string | null = null;
      let baseBranch: string | null = null;
      try {
        branch = await getCurrentBranch(input.worktreePath);
        if (branch) {
          const defaultBranch = await getDefaultBranch(input.worktreePath);
          baseBranch = await detectBaseBranch(input.worktreePath, branch, defaultBranch);
        }
      } catch (error) {
        log.warn('[switchWorktree] Failed to read git state from target worktree:', error);
      }

      const updated = await updateChatLocal(db, input.chatId, {
        worktreePath: input.worktreePath,
        branch,
        baseBranch,
      });
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found after update' });
      }

      if (oldWorktreePath) {
        gitCache.invalidateStatus(oldWorktreePath);
        gitCache.invalidateParsedDiff(oldWorktreePath);
      }
      gitCache.invalidateStatus(input.worktreePath);
      gitCache.invalidateParsedDiff(input.worktreePath);

      return {
        success: true,
        worktreePath: updated.worktreePath,
        branch: updated.branch,
        baseBranch: updated.baseBranch,
      };
    }),
});
