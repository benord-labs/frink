import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { getChatById as getChatByIdLocal } from '../../../../db/repos/chats';
import {
  clearStreamId as clearStreamIdLocal,
  getSubChatById as getSubChatByIdLocal,
  updateSubChatMessages as updateSubChatMessagesLocal,
  updateSubChatSession as updateSubChatSessionLocal,
} from '../../../../db/repos/sub-chats';
import { applyRollbackStash, type RollbackResult } from '../../../../git/stash';
import { publicProcedure, router } from '../../../index';

export function getRollbackFailureMessage(result: RollbackResult): string | null {
  if (!result.success) {
    return 'Git rollback failed';
  }
  return null;
}

/**
 * Phase 1 local-first migration: rollback writes to local SQLite directly.
 * Git side-effects (applyRollbackStash) are unchanged — they were already local.
 */
export const subChatRollbackRouter = router({
  rollbackToMessage: publicProcedure
    .input(
      z
        .object({
          subChatId: z.string(),
          sdkMessageUuid: z.string().optional(),
          userMessageId: z.string().optional(),
          mode: z.enum(['chat', 'chat-and-code']).default('chat-and-code'),
        })
        .refine((d) => d.sdkMessageUuid || d.userMessageId, {
          message: 'Either sdkMessageUuid or userMessageId is required',
        }),
    )
    .mutation(
      async ({
        input,
      }): Promise<
        | { success: false; error: string }
        | { success: true; messages: unknown[]; gitReverted: boolean }
      > => {
        const db = getDatabase();
        // A read failure PROPAGATES as a tRPC error — only a genuinely absent row is
        // "not found". See docs/decisions/sub-chat-read-failure-posture.md.
        const subChat = await getSubChatByIdLocal(db, input.subChatId);
        if (!subChat) {
          return { success: false, error: 'Sub-chat not found' };
        }

        const messages = subChat.messages as unknown[];
        let targetIndex = -1;

        if (input.userMessageId) {
          targetIndex = messages.findIndex(
            (m: unknown) => (m as Record<string, unknown>).id === input.userMessageId,
          );
        } else if (input.sdkMessageUuid) {
          targetIndex = messages.findIndex(
            (m: unknown) =>
              ((m as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
                ?.sdkMessageUuid === input.sdkMessageUuid,
          );
        }

        if (targetIndex === -1) {
          return { success: false, error: 'Message not found' };
        }

        // user-message rollback truncates EXCLUDING the target and walks back for the checkpoint —
        // applying that path to a non-user message would corrupt history and pick a wrong checkpoint.
        if (input.userMessageId) {
          const target = messages[targetIndex] as Record<string, unknown>;
          if (target.role !== 'user') {
            return { success: false, error: 'userMessageId must reference a user message' };
          }
        }

        let gitReverted = false;
        if (input.mode === 'chat-and-code') {
          let checkpointUuid: string | undefined = input.sdkMessageUuid;

          if (input.userMessageId && !checkpointUuid) {
            for (let i = targetIndex - 1; i >= 0; i--) {
              const meta = (messages[i] as Record<string, unknown>).metadata as
                | Record<string, unknown>
                | undefined;
              if (meta?.sdkMessageUuid) {
                checkpointUuid = meta.sdkMessageUuid as string;
                break;
              }
            }
          }

          if (checkpointUuid) {
            const chat = await getChatByIdLocal(db, subChat.chatId);
            if (chat?.worktreePath) {
              const res = await applyRollbackStash(chat.worktreePath, checkpointUuid);
              if (!res.success) {
                log.error('[Sub-chat Rollback] Git rollback failed', {
                  subChatId: input.subChatId,
                  checkpointUuid,
                  error: res.error,
                });
              } else if (!res.checkpointFound) {
                log.warn('[Sub-chat Rollback] Checkpoint not found — reverting chat only', {
                  subChatId: input.subChatId,
                  checkpointUuid,
                });
              } else {
                gitReverted = true;
              }
              const rollbackFailure = getRollbackFailureMessage(res);
              if (rollbackFailure) {
                return { success: false, error: rollbackFailure };
              }
            }
          }
        }

        const sliceEnd = input.userMessageId ? targetIndex : targetIndex + 1;
        let truncatedMessages: unknown[] = messages.slice(0, sliceEnd);

        // claude.ts resume logic looks for shouldResume on the last *assistant* message,
        // so we must place it there even when the truncation target is a user message.
        let resumeIndex = -1;
        for (let i = truncatedMessages.length - 1; i >= 0; i--) {
          if ((truncatedMessages[i] as Record<string, unknown>).role === 'assistant') {
            resumeIndex = i;
            break;
          }
        }

        truncatedMessages = truncatedMessages.map((m: unknown, i: number) => {
          const msg = m as Record<string, unknown>;
          const metadata = (msg.metadata as Record<string, unknown>) || {};
          const { shouldResume: _, ...restMeta } = metadata;
          return {
            ...msg,
            metadata: {
              ...restMeta,
              ...(i === resumeIndex && { shouldResume: true }),
            },
          };
        });

        // ORDER IS LOAD-BEARING — stream teardown first, transcript last.
        //
        // Phase 1 ship-blocker fix (commit f655a8): clear stream_id so any in-flight chunk
        // persistence in src/main/lib/socket/client.ts:persistAssistantChunkLocally hits the
        // post-rollback guard in upsertAssistantMessage and drops rather than re-appending.
        // These are three separate awaits, so withSubChatLock serializes each one but does not
        // span them. Truncating first would leave a window where stream_id is still set and a
        // chunk persister sees `idx === -1`, skips that guard, and re-appends a message the
        // user just rolled away — the very corruption f655a8 exists to prevent.
        //
        // It is also the safer partial state if a write fails: a cleared session over an intact
        // transcript merely loses resume continuity, whereas a truncated transcript still
        // pointing at a live session resumes against history that no longer exists.
        await clearStreamIdLocal(db, input.subChatId);
        // updateSubChatSession requires a non-null string in current signature; pass empty
        // string and let the column hold "" (Drizzle accepts it). Renderer treats empty as none.
        await updateSubChatSessionLocal(db, input.subChatId, '', 'rollback');
        await updateSubChatMessagesLocal(
          db,
          input.subChatId,
          truncatedMessages as Parameters<typeof updateSubChatMessagesLocal>[2],
        );

        return {
          success: true,
          messages: truncatedMessages,
          gitReverted,
        };
      },
    ),
});
