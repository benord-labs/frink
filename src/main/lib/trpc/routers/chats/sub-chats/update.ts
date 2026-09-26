import { z } from 'zod';
import { getDatabase } from '../../../../db';
import { withSubChatLock } from '../../../../db/repos/sub-chat-mutex';
import {
  getSubChatById as getSubChatByIdLocal,
  seedUserMessageIfEmpty as seedUserMessageIfEmptyLocal,
  updateSubChatMessages as updateSubChatMessagesLocal,
  updateSubChatMode as updateSubChatModeLocal,
  updateSubChatSession as updateSubChatSessionLocal,
} from '../../../../db/repos/sub-chats';
import { sendSubChatModeChange } from '../../../../socket/client';
import { publicProcedure, router } from '../../../index';
import { renameChatHierarchy } from '../helpers';
import { mapSubChatResponse } from './map-sub-chat-response';

const seedUserMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.literal('user'),
    parts: z
      .array(z.object({ type: z.literal('text'), text: z.string().trim().min(1) }).strict())
      .length(1),
  })
  .strict();

/**
 * Phase 1 local-first migration: sub-chat updates write to local SQLite directly.
 * The bulk-messages mutation goes through the mutex-protected RMW helper so concurrent
 * streaming chunks don't lose updates.
 */
export const subChatUpdateRouter = router({
  seedUserMessageIfEmpty: publicProcedure
    .input(z.object({ id: z.string().min(1), message: seedUserMessageSchema }).strict())
    .mutation(async ({ input }) => {
      const result = await seedUserMessageIfEmptyLocal(getDatabase(), input.id, input.message);
      return {
        seeded: result.seeded,
        subChat: result.subChat ? mapSubChatResponse(result.subChat) : null,
      };
    }),
  updateSubChatMessages: publicProcedure
    .input(z.object({ id: z.string(), messages: z.string() }))
    .mutation(async ({ input }) => {
      const messages = JSON.parse(input.messages);
      const updated = await updateSubChatMessagesLocal(getDatabase(), input.id, messages);
      return updated ? mapSubChatResponse(updated) : null;
    }),

  updateSubChatSession: publicProcedure
    .input(z.object({ id: z.string(), sessionId: z.string().nullable() }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      // sessionId nullable: treat empty string as null too, matching cloud semantics.
      await updateSubChatSessionLocal(
        db,
        input.id,
        input.sessionId ?? '',
        'updateSubChatSession mutation',
      );
      const fresh = await getSubChatByIdLocal(db, input.id);
      return fresh ? mapSubChatResponse(fresh) : null;
    }),

  updateSubChatMode: publicProcedure
    .input(z.object({ id: z.string(), mode: z.enum(['plan', 'agent', 'debug']) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      // The whole write→re-read→broadcast runs under the per-sub-chat mutex so two rapid
      // toggles cannot interleave and echo out of order (a late stale echo would revert the
      // renderer mirrors). Phase 1.5 fix D: repo signature matches the Zod enum, no cast needed.
      return withSubChatLock(input.id, async () => {
        await updateSubChatModeLocal(db, input.id, input.mode);
        const fresh = await getSubChatByIdLocal(db, input.id);
        // Broadcast AFTER the write lands: every row-mode writer must emit the echo — it is what
        // clears the renderer's pending transition intent (decision `sub-chat-mode-ownership`);
        // without it a toggled-but-unsent intent stays armed forever. The echo carries the
        // CONFIRMED row value, never the requested one.
        if (fresh) {
          sendSubChatModeChange({
            chatId: fresh.chatId,
            subChatId: fresh.id,
            mode: fresh.mode as (typeof input)['mode'],
          });
        }
        return fresh ? mapSubChatResponse(fresh) : null;
      });
    }),

  renameSubChat: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // The oldest sub-chat's title IS the parent chat's title (the convention
      // autoNameSubChat follows), so renaming it must rename the parent and broadcast —
      // otherwise the sidebar (which renders the parent name and only patches on
      // `chats:name-updated`) goes stale. Renaming a non-oldest sub-chat touches only
      // that sub-chat: no parent write, no broadcast (a broadcast would relabel the
      // parent in the sidebar; the renderer's optimistic store write covers its tab).
      const result = await renameChatHierarchy(getDatabase(), { kind: 'sub-chat', ...input });
      if (result.kind !== 'sub-chat' || !result.value) return null;
      return mapSubChatResponse(result.value);
    }),
});
