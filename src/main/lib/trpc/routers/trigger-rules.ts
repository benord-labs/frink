/** Trigger rules, stubbed for v1 local-first: reads return safe defaults, mutations throw
 * PRECONDITION_FAILED; only `getEventTypes` (a pure catalog lookup the renderer's dropdowns use) does work. */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { PROVIDER_IDS } from '../../../../shared/integrations/providers';
import { getEventTypes } from '../../../../shared/integrations/selectors';
import { publicProcedure, router } from '../index';

const GATED_MESSAGE = 'Trigger rules are not available in this version.';

function gated(): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: GATED_MESSAGE });
}

export const triggerRulesRouter = router({
  listByIntegration: publicProcedure
    .input(z.object({ integrationId: z.string().min(1) }))
    .query(() => [] as never[]),

  listAll: publicProcedure.query(() => [] as never[]),

  get: publicProcedure.input(z.object({ ruleId: z.string().min(1) })).query(() => null as null),

  create: publicProcedure
    .input(z.object({ integrationId: z.string().min(1) }).passthrough())
    .mutation(() => gated()),

  update: publicProcedure
    .input(z.object({ ruleId: z.string().min(1) }).passthrough())
    .mutation(() => gated()),

  toggle: publicProcedure
    .input(z.object({ ruleId: z.string().min(1), isActive: z.boolean() }))
    .mutation(() => gated()),

  delete: publicProcedure
    .input(z.object({ ruleId: z.string().min(1) }))
    .mutation(() => ({ success: false as const, error: 'Trigger rules deferred (gated)' })),

  getEventTypes: publicProcedure
    .input(z.object({ provider: z.string().refine((id) => PROVIDER_IDS.includes(id)) }))
    .query(({ input }) => getEventTypes(input.provider)),

  migrateToFlows: publicProcedure.mutation(() => ({
    migrated: 0,
    migratedIds: [] as string[],
    failed: [] as Array<{ id: string; error: string }>,
  })),
});
