import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import { normalizeFlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { trackFlowCreated } from '../../../analytics';
import { getDatabase } from '../../../db';
import { getLatestVersion } from '../../../db/repos/flow-versions';
import {
  copyFlow,
  FlowCopyNoSavedVersionError,
  FlowCopyNotFoundError,
} from '../../../db/repos/flows';
import { flowTriggerKind } from '../../../flows/usage-telemetry';
import { publicProcedureRaw } from '../../index';

export function createFlowCopyProcedures() {
  return {
    copy: publicProcedureRaw
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ input }) => {
        try {
          const db = getDatabase();
          const copy = await copyFlow(db, { sourceFlowId: input.id });
          const version = await getLatestVersion(db, copy.id);
          const graph = version ? normalizeFlowGraph(version.graph) : null;
          trackFlowCreated({ id: copy.id, triggerType: flowTriggerKind(graph), createdBy: 'copy' });
          return copy;
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
