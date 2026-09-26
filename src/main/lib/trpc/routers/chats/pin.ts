import { z } from 'zod';
import { getDatabase } from '../../../db';
import { togglePin as togglePinLocal } from '../../../db/repos/chats';
import { publicProcedure, router } from '../../index';
import { mapLocalChatResponse } from './map-chat-response';

/**
 * Phase 1 local-first migration: pin toggle writes to local SQLite directly.
 */
export const pinRouter = router({
  togglePin: publicProcedure
    // Local cuid2 chat id, not a UUID (Phase 1 local-first migration) — validate non-empty.
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const chat = await togglePinLocal(getDatabase(), input.id);
      return chat ? mapLocalChatResponse(chat) : null;
    }),
});
