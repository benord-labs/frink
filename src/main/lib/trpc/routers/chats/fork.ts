import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../db';
import { forkChatWithSubChats as forkChatWithSubChatsLocal } from '../../../db/repos/chats';
import { getAiAccountType } from '../../../db/repos/project-ai-accounts';
import { getProjectById } from '../../../db/repos/projects';
import type { Chat, SubChat } from '../../../db/schema';
import { publicProcedure, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';

type Db = ReturnType<typeof getDatabase>;

const NOT_FOUND_RE = /not found/i;

const forkInput = z.object({ chatId: z.string(), accountId: z.string().optional() });

/** The AI login a fork moves onto; any other credential id is NOT_FOUND. */
async function resolveForkAccount(db: Db, accountId?: string) {
  if (!accountId) return undefined;
  const type = await getAiAccountType(db, accountId);
  if (!type) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
  return { id: accountId, type };
}

/** The renderer-facing fork; an unset worktree falls back to the project folder. */
async function forkResponse(db: Db, chat: Chat, subChats: SubChat[]) {
  const project = chat.projectId ? await getProjectById(db, chat.projectId) : null;
  return {
    ...mapLocalChatResponse(chat),
    worktreePath: chat.worktreePath ?? project?.path ?? null,
    branch: chat.branch ?? null,
    baseBranch: chat.baseBranch ?? null,
    subChats: subChats.map((sc) => ({
      id: sc.id,
      name: sc.name,
      chatId: sc.chatId,
      sessionId: sc.sessionId,
      streamId: sc.streamId,
      mode: sc.mode,
      messages: sc.messages,
      createdAt: sc.createdAt,
      updatedAt: sc.updatedAt,
      additions: sc.additions ?? 0,
      deletions: sc.deletions ?? 0,
      fileCount: sc.fileCount ?? 0,
    })),
  };
}

/**
 * Phase 1 local-first migration: chat fork is a deep-copy in local SQLite (chat + sub-chats
 * inside one transaction with fresh IDs). The fork inherits the source worktree/branch.
 */
export const forkRouter = router({
  fork: publicProcedure.input(forkInput).mutation(async ({ input }) => {
    try {
      const db = getDatabase();
      const account = await resolveForkAccount(db, input.accountId);

      let chat: Awaited<ReturnType<typeof forkChatWithSubChatsLocal>>['chat'];
      let subChats: Awaited<ReturnType<typeof forkChatWithSubChatsLocal>>['subChats'];
      try {
        const forkResult = await forkChatWithSubChatsLocal(db, input.chatId, account);
        chat = forkResult.chat;
        subChats = forkResult.subChats;
      } catch (err) {
        if (err instanceof Error && NOT_FOUND_RE.test(err.message)) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
        }
        throw err;
      }

      return await forkResponse(db, chat, subChats);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      log.error('[Chat Fork] Failed:', message, err);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
    }
  }),
});
