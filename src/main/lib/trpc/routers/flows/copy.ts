import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { getDatabase } from '../../../db';
import {
  copyFlow,
  FlowCopyNoSavedVersionError,
  FlowCopyNotFoundError,
} from '../../../db/repos/flows';
import { publicProcedureRaw } from '../../index';

export function createFlowCopyProcedures() {
  return {
    copy: publicProcedureRaw
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ input }) => {
        try {
          return await copyFlow(getDatabase(), {
            sourceFlowId: input.id,
          });
        } catch (error) {
          if (error instanceof FlowCopyNotFoundError) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
          }
          if (error instanceof FlowCopyNoSavedVersionError) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Save the flow before copying.',
            });
          }
          log.error('[Flows] Could not copy flow', {
            flowId: input.id,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not copy flow' });
        }
      }),
  };
}
