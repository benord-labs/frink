/** tRPC flow trigger bindings (local SQLite): post-task and schedule only. A webhook trigger has no
 * binding row, since its flow-graph node is matched directly, so the repo rejects those writes. */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  type BindingConfigTriggerType,
  bindingConfigSchemaFor,
  isBindingConfigTriggerType,
  postTaskBindingConfigSchema,
  scheduleBindingConfigSchema,
} from '../../../../shared/types/flows/flow-trigger-binding-config';
import type { DbFlowTriggerBinding } from '../../cloud/trigger-bindings';
import { getDatabase } from '../../db';
import * as bindingsRepo from '../../db/repos/flow-trigger-bindings';
import {
  TriggerScopeAlreadyActiveError,
  TriggerTypeNotSupportedError,
} from '../../db/repos/flow-trigger-bindings';
import { toRawDbFlowTriggerBinding } from '../../integrations/adapters';
import { publicProcedure, router } from '../index';

const bindingScope = {
  flowId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
};

/** Each trigger type carries its own config shape, so a wrong-shape config is rejected before it is stored. */
const createBindingInputSchema = z.discriminatedUnion('triggerType', [
  z.object({
    ...bindingScope,
    triggerType: z.literal('post_task_trigger'),
    config: postTaskBindingConfigSchema,
  }),
  z.object({
    ...bindingScope,
    triggerType: z.literal('schedule_trigger'),
    config: scheduleBindingConfigSchema,
  }),
]);

/** An update names no trigger type, so its config is checked against the stored row's type. */
async function storedTriggerTypeOf(
  db: ReturnType<typeof getDatabase>,
  id: string,
): Promise<BindingConfigTriggerType | null> {
  const existing = await bindingsRepo.getById(db, id);
  if (!existing) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger binding not found' });
  }
  return isBindingConfigTriggerType(existing.triggerType) ? existing.triggerType : null;
}

function mapRepoError(e: unknown): never {
  if (e instanceof TriggerTypeNotSupportedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
  }
  if (e instanceof TriggerScopeAlreadyActiveError) {
    throw new TRPCError({ code: 'CONFLICT', message: e.message, cause: e });
  }
  throw e;
}

export const triggerBindingsRouter = router({
  list: publicProcedure
    .input(
      z.union([
        z.object({ flowId: z.string().min(1) }),
        z.object({ projectId: z.string().min(1) }),
      ]),
    )
    .query(async ({ input }): Promise<DbFlowTriggerBinding[]> => {
      const db = getDatabase();
      const rows =
        'flowId' in input
          ? await bindingsRepo.listForFlow(db, input.flowId)
          : await bindingsRepo.listForProject(db, input.projectId);
      return rows.map(toRawDbFlowTriggerBinding) as unknown as DbFlowTriggerBinding[];
    }),

  create: publicProcedure
    .input(createBindingInputSchema)
    .mutation(async ({ input }): Promise<DbFlowTriggerBinding> => {
      const db = getDatabase();
      try {
        const row = await bindingsRepo.create(db, {
          flowId: input.flowId,
          projectId: input.projectId,
          triggerType: input.triggerType,
          config: input.config,
          isActive: true,
        });
        return toRawDbFlowTriggerBinding(row) as unknown as DbFlowTriggerBinding;
      } catch (e) {
        mapRepoError(e);
      }
    }),

  update: publicProcedure
    .input(
      z
        .object({
          id: z.string().min(1),
          config: z.record(z.string(), z.unknown()).optional(),
          isActive: z.boolean().optional(),
          // clearLastError is a one-way action — only `true` clears the
          // error fields. `false` is rejected at the router so it can't
          // pose as a "meaningful patch" while the repo treats it as a no-op.
          clearLastError: z.literal(true).optional(),
        })
        .superRefine((data, ctx) => {
          if (
            data.config === undefined &&
            data.isActive === undefined &&
            data.clearLastError === undefined
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'Provide at least one of: config, isActive, or clearLastError to update a trigger binding',
            });
          }
        }),
    )
    .mutation(async ({ input }): Promise<DbFlowTriggerBinding> => {
      const db = getDatabase();
      if (input.config !== undefined) {
        const triggerType = await storedTriggerTypeOf(db, input.id);
        const parsed = triggerType && bindingConfigSchemaFor(triggerType).safeParse(input.config);
        if (parsed && !parsed.success) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Config does not match what a ${triggerType} binding expects`,
            cause: parsed.error,
          });
        }
      }
      const row = await bindingsRepo
        .update(db, input.id, {
          config: input.config,
          isActive: input.isActive,
          clearLastError: input.clearLastError,
        })
        .catch(mapRepoError);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Trigger binding not found' });
      }
      return toRawDbFlowTriggerBinding(row) as unknown as DbFlowTriggerBinding;
    }),

  // Idempotent: the row has no side effects, so "already gone" (double-click, stale id) is success.
  delete: publicProcedure.input(z.object({ id: z.string().min(1) })).mutation(async ({ input }) => {
    await bindingsRepo.deleteBinding(getDatabase(), input.id);
    return { ok: true as const };
  }),
});
