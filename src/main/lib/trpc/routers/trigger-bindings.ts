/** tRPC flow trigger bindings (local SQLite): post-task and schedule only. A webhook trigger has no
 * binding row, since its flow-graph node is matched directly, so the repo rejects those writes. */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { DbFlowTriggerBinding } from '../../cloud/trigger-bindings';
import { getDatabase } from '../../db';
import * as bindingsRepo from '../../db/repos/flow-trigger-bindings';
import {
  TriggerProjectRequiredError,
  TriggerScopeAlreadyActiveError,
  TriggerTypeNotSupportedError,
} from '../../db/repos/flow-trigger-bindings';
import { toRawDbFlowTriggerBinding } from '../../integrations/adapters';
import { publicProcedure, router } from '../index';

const triggerTypeSchema = z.enum(['post_task_trigger', 'schedule_trigger']);

function mapRepoError(e: unknown): never {
  if (e instanceof TriggerTypeNotSupportedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: e });
  }
  if (e instanceof TriggerProjectRequiredError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: e });
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
    .input(
      z.object({
        flowId: z.string().min(1),
        projectId: z.string().min(1).nullable(),
        triggerType: triggerTypeSchema,
        config: z.record(z.string(), z.unknown()),
      }),
    )
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
      const row = await bindingsRepo
        .update(db, input.id, {
          config: input.config as Record<string, unknown> | undefined,
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
