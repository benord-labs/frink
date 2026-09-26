import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router } from '../index';
import {
  ACCOUNT_MISSING,
  localConfigure,
  localConfigureApiToken,
  localConfirmNotion,
  localIdField,
  localImportClickup,
  localImportVendorSecret,
  localOptions,
  localRestartNotion,
} from './local-trigger-endpoints';

const endpointInput = z.object({
  integrationId: localIdField(),
  webhookId: localIdField(),
});

/** Every setup step acts on a row this machine holds; an unknown id is refused, never sent out. */
function orMissing<T>(outcome: T | null): T {
  if (outcome === null) throw new TRPCError({ code: 'NOT_FOUND', message: ACCOUNT_MISSING });
  return outcome;
}

export const triggerSetupRouter = router({
  options: publicProcedure
    .input(endpointInput)
    .query(async ({ input }) => orMissing(await localOptions(input.integrationId))),
  configure: publicProcedure
    .input(
      endpointInput.extend({
        selection: z.array(z.string().min(1)).min(1).max(100),
      }),
    )
    .mutation(async ({ input }) => orMissing(await localConfigure(input))),
  configureApiToken: publicProcedure
    .input(
      endpointInput.extend({
        apiKey: z.string().trim().max(1024).optional(),
        selection: z.array(z.string().trim().min(1).max(300)).min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => orMissing(await localConfigureApiToken(input))),
  importClickupWebhook: publicProcedure
    .input(
      endpointInput.extend({
        vendorWebhookId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        secret: z.string().trim().min(1).max(512),
      }),
    )
    .mutation(async ({ input }) => orMissing(await localImportClickup(input))),
  importVendorWebhook: publicProcedure
    .input(endpointInput.extend({ secret: z.string().trim().min(1).max(512) }))
    .mutation(async ({ input }) => orMissing(await localImportVendorSecret(input))),
  confirmNotion: publicProcedure
    .input(
      endpointInput.extend({
        generation: z.string().min(1),
        candidate: z.string().startsWith('notion:pending:'),
      }),
    )
    .mutation(async ({ input }) => orMissing(await localConfirmNotion(input))),
  restartNotion: publicProcedure
    .input(
      endpointInput.extend({
        generation: z.string().min(1),
        candidate: z.string().nullable(),
      }),
    )
    .mutation(async ({ input }) => orMissing(await localRestartNotion(input))),
});
