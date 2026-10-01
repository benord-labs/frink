import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CODEX_SPEEDS } from '../../../../../shared/types/execution';
import {
  importComposerSettings,
  listComposerSettings,
  readComposerSettings,
  setThinkingEnabled,
  updateComposerSettings,
} from '../../../chat-composer';
import { publicProcedure, router } from '../../index';

const chatId = z.string().min(1);
// Any picker id: desktop has always tolerated stale ids (execution resolves the fallback), and a
// Flow can seed ids outside the visible catalog.
const modelId = z.string().min(1).max(200);

export const composerPatchSchema = z
  .object({
    modelId: modelId.optional(),
    autoMode: z.boolean().optional(),
    codexSpeed: z.enum(CODEX_SPEEDS).optional(),
  })
  .strict();

function notFound(): never {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
}

/** Composer settings shared by every window and the phone (see main/lib/chat-composer). */
export const composerRouter = router({
  getComposerSettings: publicProcedure
    .input(z.object({ chatId }))
    .query(({ input }) => readComposerSettings(input.chatId) ?? notFound()),

  listComposerSettings: publicProcedure.query(() => listComposerSettings()),

  updateComposerSettings: publicProcedure
    .input(z.object({ chatId, patch: composerPatchSchema }))
    .mutation(({ input }) => updateComposerSettings(input.chatId, input.patch) ?? notFound()),

  setThinkingEnabled: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => ({ thinkingEnabled: setThinkingEnabled(input.enabled) })),

  importComposerSettings: publicProcedure
    .input(
      z.object({
        entries: z.array(z.object({ chatId }).merge(composerPatchSchema)).max(5000),
        thinkingEnabled: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      importComposerSettings(input);
      return { ok: true as const };
    }),
});
