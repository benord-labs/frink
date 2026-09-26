import { z } from 'zod';
import { getDatabase } from '../../../db';
import { getChatById as getChatByIdLocal } from '../../../db/repos/chats';
import { getProjectById } from '../../../db/repos/projects';
import { listSubChatsByChat as listSubChatsByChatLocal } from '../../../db/repos/sub-chats';
import { publicProcedure, router } from '../../index';
import { mapChatProject, mapLocalChatResponse } from './map-chat-response';

/**
 * Phase 1 local-first migration: read a single chat (with sub-chats + project) from local
 * SQLite. Every project on this machine is "local" by definition.
 *
 * sub_chats.messages comes back as the JSON string (renderer parses it on demand). The
 * cloud variant of this endpoint elided messages from the bulk response too — we mirror
 * that behaviour by stringifying an empty array; full messages are fetched per-sub-chat
 * via `chats.getSubChatMessages`.
 */
export const getRouter = router({
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const db = getDatabase();

    const chat = await getChatByIdLocal(db, input.id);
    if (!chat) return null;

    const subChats = await listSubChatsByChatLocal(db, chat.id);

    const project = mapChatProject(
      chat.projectId ? await getProjectById(db, chat.projectId) : null,
    );

    return {
      ...mapLocalChatResponse(chat),
      subChats: subChats.map((sc) => ({
        id: sc.id,
        name: sc.name,
        chatId: sc.chatId,
        sessionId: sc.sessionId,
        streamId: sc.streamId,
        mode: sc.mode,
        messages: '[]',
        createdAt: sc.createdAt,
        updatedAt: sc.updatedAt,
        additions: sc.additions ?? 0,
        deletions: sc.deletions ?? 0,
        fileCount: sc.fileCount ?? 0,
      })),
      project,
    };
  }),
});
