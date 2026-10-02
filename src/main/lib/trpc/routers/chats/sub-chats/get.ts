import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import { getProjectById } from '../../../../db/repos/projects';
import { getSubChatById as getSubChatByIdLocal } from '../../../../db/repos/sub-chats';
import { publicProcedure, publicProcedureRaw, router } from '../../../index';
import { mapChatProject } from '../map-chat-response';
import { mapSubChatResponse } from './map-sub-chat-response';
import { paginateMessages } from './messages-utils';

const DEFAULT_MESSAGES_LIMIT = 20;

/**
 * Phase 1 local-first migration: read sub-chats from local SQLite. The in-memory messages
 * cache is no longer needed (the local read is already in-process and faster than the
 * cache hit ever was on cloud); the file is left in place but its callers are gone.
 */
export const subChatGetRouter = router({
  // Raw: the renderer reads the stored SDK transcript's tool keys (`input.file_path`) verbatim.
  // See decision `flows-ipc-casing-contract`.
  getSubChatMessages: publicProcedureRaw
    .input(
      z.object({
        subChatId: z.string(),
        limit: z.number().min(1).max(100).default(DEFAULT_MESSAGES_LIMIT),
        beforeMessageId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const { subChatId, limit, beforeMessageId } = input;
      const subChat = await getSubChatByIdLocal(getDatabase(), subChatId);
      if (!subChat) {
        return { messages: [], hasMore: false, sessionId: null };
      }

      const arr = subChat.messages as { id?: string }[];
      if (arr.length === 0) {
        return { messages: [], hasMore: false, sessionId: subChat.sessionId ?? null };
      }

      const { messages: slice, hasMore } = paginateMessages(arr, limit, beforeMessageId);
      return { messages: slice, hasMore, sessionId: subChat.sessionId ?? null };
    }),

  getSubChat: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const db = getDatabase();
    const subChat = await getSubChatByIdLocal(db, input.id);
    if (!subChat) return null;

    const chat = await getChatByIdLocal(db, subChat.chatId);

    const project = mapChatProject(
      chat?.projectId ? await getProjectById(db, chat.projectId) : null,
    );

    return {
      ...mapSubChatResponse(subChat),
      chat: chat
        ? {
            id: chat.id,
            name: chat.name,
            projectId: chat.projectId,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            archivedAt: chat.archivedAt,
            worktreePath: chat.worktreePath,
            branch: chat.branch,
            baseBranch: chat.baseBranch,
            prUrl: chat.prUrl,
            prNumber: chat.prNumber,
            taskId: chat.taskId,
            project,
          }
        : null,
    };
  }),
});
