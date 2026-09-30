import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../db';
import { getChatById, moveChatToProjectLocal, parseWorktreeHistory } from '../../../db/repos/chats';
import { setChatAiAccount } from '../../../db/repos/project-ai-accounts';
import { listSubChatsByChat } from '../../../db/repos/sub-chats';
import { gitCache } from '../../../git/cache';
import { resolveTargetWorktreeForMove } from '../../../git/resolve-target-worktree';
import { retireRetainedSession } from '../../../socket/claude-session-registry';
import { releaseWakeHold } from '../../../socket/claude-wake-hold';
import { publicProcedure, router } from '../../index';
import { renameChatHierarchy } from './helpers';
import { mapLocalChatResponse } from './map-chat-response';

/**
 * Chat update operations.
 *
 * Phase 1 local-first migration: writes go to local SQLite directly.
 */
export const updateRouter = router({
  /** Rename a chat. */
  rename: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const result = await renameChatHierarchy(getDatabase(), { kind: 'chat', ...input });
      if (result.kind !== 'chat' || !result.value) return null;
      return mapLocalChatResponse(result.value);
    }),

  /**
   * Move a chat to a different project (null = General Chats).
   *
   * Auto-restores a previous worktree if the destination project is one this chat visited
   * before (history lookup in `resolveTargetWorktreeForMove`). Otherwise lands at the new
   * project's root (the renderer supplies the authoritative `projectPath`; a cloud projectId
   * can't be mapped to a local path here — see chats/create.ts). The non-worktree invariant
   * `worktreePath === project.path` still holds in the fallback case so the moved chat
   * isn't mislabelled as a worktree.
   */
  moveToProject: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        projectId: z.string().nullable(),
        projectPath: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const db = getDatabase();
        const sourceChat = await getChatById(db, input.chatId);
        if (!sourceChat) return null;

        const history = parseWorktreeHistory(sourceChat.worktreeHistory);
        const resolved = await resolveTargetWorktreeForMove({
          targetProjectId: input.projectId,
          targetProjectPath: input.projectPath ?? null,
          explicitWorktreePath: null,
          history,
        });

        const { updated, previousWorktreePath } = await moveChatToProjectLocal(db, input.chatId, {
          projectId: input.projectId,
          worktreePath: resolved.worktreePath,
          branch: resolved.branch,
          baseBranch: resolved.baseBranch,
          stalePrunedProjectId: resolved.stalePrunedProjectId,
        });

        // Invalidate gitCache for BOTH the old and new paths — the new path may carry stale
        // cache from a prior visit (auto-restore reuses the original worktree).
        if (previousWorktreePath && previousWorktreePath !== resolved.worktreePath) {
          gitCache.invalidateStatus(previousWorktreePath);
          gitCache.invalidateParsedDiff(previousWorktreePath);
        }
        if (resolved.worktreePath) {
          gitCache.invalidateStatus(resolved.worktreePath);
          gitCache.invalidateParsedDiff(resolved.worktreePath);
        }

        return updated ? mapLocalChatResponse(updated) : null;
      } catch (error) {
        log.warn('[chats.update] moveToProject failed:', { error, input });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to move chat to project',
          cause: error,
        });
      }
    }),

  /** Swap a chat to another login of the same provider; it resumes natively on its next turn. */
  setChatAccount: publicProcedure
    .input(z.object({ chatId: z.string(), accountId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const result = await setChatAiAccount(db, input.chatId, input.accountId);
      if (result === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat or account not found' });
      }
      if (result === 'other-provider') {
        const message = 'Another provider continues this chat in a new chat';
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
      // No old-login session serves the next turn: idle ones retire, wake holds end, busy ones are
      // fenced to end with their turn.
      for (const sub of await listSubChatsByChat(db, input.chatId)) {
        retireRetainedSession(sub.id, 'credential-change');
        releaseWakeHold(sub.id, 'credential-change');
      }
      return { success: true as const };
    }),
});
