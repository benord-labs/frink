/**
 * Integrations Router
 * The trigger accounts this machine holds; there is no other place an account can live.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { DbTriggerRule } from '../../cloud-client';
import { getDatabase } from '../../db';
import {
  localIntegrationRows,
  type TriggerAccount,
  triggerRelayStatus,
  WEBHOOK_ENDPOINT_LIMIT,
} from '../../webhooks';
import { publicProcedure, router } from '../index';
import { createTriggerEndpointProcedures } from './integrations-trigger-endpoints';
import {
  ACCOUNT_MISSING,
  createLocalTriggerProcedures,
  localDeactivate,
  localDisconnect,
  localIdField,
  localList,
  localRotate,
} from './local-trigger-endpoints';

// Integration with trigger rules for detail view
export type IntegrationWithRules = TriggerAccount & {
  triggerRules: DbTriggerRule[];
};

export const integrationsRouter = router({
  /** Every trigger account on this machine. */
  list: publicProcedure.query(() => localIntegrationRows(getDatabase())),

  /**
   * Get a single integration with its trigger rules
   */
  get: publicProcedure
    .input(z.object({ integrationId: z.string().min(1) }))
    .query(async ({ input }): Promise<IntegrationWithRules | null> => {
      const integration = (await localIntegrationRows(getDatabase())).find(
        (row) => row.id === input.integrationId,
      );
      if (!integration) {
        return null;
      }

      // trigger_rules table stays cloud (parked per design §29). v1 has no
      // local consumer; the trigger-rules router stub returns [] for
      // listByIntegration. Return [] inline to keep the cloud HTTP path off
      // the local-first call path.
      const triggerRules: DbTriggerRule[] = [];
      return { ...integration, triggerRules };
    }),

  ...createLocalTriggerProcedures(),

  /** Forget a trigger account this machine holds. */
  disconnectIntegration: publicProcedure
    .input(
      z.object({
        integrationId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const local = await localDisconnect(input.integrationId);
      if (!local) throw new TRPCError({ code: 'NOT_FOUND', message: 'Integration not found' });
      return local;
    }),

  listWebhookEndpoints: publicProcedure
    .input(z.object({ integrationId: z.string().min(1) }))
    .query(async ({ input }) => {
      const local = await localList(input.integrationId);
      if (local) return local;
      return { success: false as const, error: ACCOUNT_MISSING };
    }),

  ...createTriggerEndpointProcedures({ endpointLimit: WEBHOOK_ENDPOINT_LIMIT }),

  /** The public address every trigger on this machine hangs off, and whether it is answering. */
  getTriggerRelay: publicProcedure.query(() => triggerRelayStatus()),

  rotateWebhookEndpoint: publicProcedure
    .input(
      z.object({
        integrationId: z.string().min(1),
        webhookId: localIdField(),
      }),
    )
    .mutation(async ({ input }) => {
      const local = await localRotate(input.integrationId, input.webhookId);
      if (local) return local;
      return { success: false as const, error: ACCOUNT_MISSING };
    }),

  deactivateWebhookEndpoint: publicProcedure
    .input(
      z.object({
        integrationId: z.string().min(1),
        webhookId: localIdField(),
      }),
    )
    .mutation(async ({ input }) => {
      const local = await localDeactivate(input.integrationId, input.webhookId);
      if (local) return local;
      return { success: false as const, error: ACCOUNT_MISSING };
    }),
});
