import { TRPCError } from '@trpc/server';
import { publicProcedure } from '../index';
import { z } from 'zod';
import {
  ACCOUNT_MISSING,
  localGenerate,
  localIdField,
  localRetry,
} from './local-trigger-endpoints';

/** Endpoint creation and same-address registration recovery for the integrations router. */
export function createTriggerEndpointProcedures({ endpointLimit }: { endpointLimit: number }) {
  return {
    generateWebhookEndpoint: publicProcedure
      .input(z.object({ integrationId: localIdField() }))
      .mutation(async ({ input }) => {
        const local = await localGenerate(input.integrationId, endpointLimit);
        return local ?? { success: false as const, error: ACCOUNT_MISSING };
      }),

    retryWebhookEndpoint: publicProcedure
      .input(z.object({ integrationId: localIdField(), webhookId: localIdField() }))
      .mutation(async ({ input }) => {
        // The card reads only a thrown error here, so a missing account throws like a vendor refusal does.
        const local = await localRetry(input);
        if (!local) throw new TRPCError({ code: 'NOT_FOUND', message: ACCOUNT_MISSING });
        return local;
      }),
  };
}
