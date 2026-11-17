import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { flowSettingsSchema } from '../../../../../shared/types/flow';
import {
  flowGraphEdgeSchema,
  flowGraphNodeSchema,
} from '../../../../../shared/types/flow-graph-schema';
import { getDatabase } from '../../../db';
import { toDbFlowVersion } from '../../../flows/adapters';
import {
  commitFlowVersion,
  type FlowVersionCommittedDto,
  subscribeFlowVersionCommitted,
} from '../../../flows/version-events';
import { publicProcedureRaw } from '../../index';
import { mapEngineError } from './run-actions';

const flowGraphSchema = z.object({
  nodes: z.array(flowGraphNodeSchema),
  edges: z.array(flowGraphEdgeSchema),
  settings: flowSettingsSchema,
});

export function createFlowVersionProcedures() {
  return {
    saveVersion: publicProcedureRaw
      .input(
        z.object({
          flowId: z.string().min(1),
          graph: flowGraphSchema,
          expectedVersionNumber: z.number().int().min(0).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const db = getDatabase();
        try {
          const row = await commitFlowVersion(
            db,
            {
              flowId: input.flowId,
              graph: input.graph,
              expectedVersionNumber: input.expectedVersionNumber,
            },
            'ui',
          );
          return toDbFlowVersion(row);
        } catch (e) {
          mapEngineError(e);
        }
      }),

    /** Pushes each newly committed version of one flow, so an open editor need not wait for its poll. */
    onVersionCommitted: publicProcedureRaw
      .input(z.object({ flowId: z.string().min(1) }))
      .subscription(({ input }) =>
        observable<FlowVersionCommittedDto>((emit) =>
          subscribeFlowVersionCommitted((event) => {
            if (event.flowId !== input.flowId) return;
            emit.next({
              flow_id: event.flowId,
              version_number: event.versionNumber,
              source: event.source,
            });
          }),
        ),
      ),
  };
}
