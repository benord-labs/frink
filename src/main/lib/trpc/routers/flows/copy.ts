import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import { z } from 'zod';
import {
  localizeFlowGraph,
  MAX_FLOW_FILE_BYTES,
  parseFlowFile,
} from '../../../../../shared/lib/flows/flow-file';
import { normalizeFlowGraph, validateGraph } from '../../../../../shared/lib/validate-flow-graph';
import { trackFlowCreated } from '../../../analytics';
import { getDatabase } from '../../../db';
import { getLatestVersion } from '../../../db/repos/flow-versions';
import {
  copyFlow,
  createFlowWithFirstVersion,
  FlowCopyNoSavedVersionError,
  FlowCopyNotFoundError,
} from '../../../db/repos/flows';
import { listProjects } from '../../../db/repos/projects';
import { listLocalIntegrations } from '../../../db/repos/webhook-ingress/management';
import { flowTriggerKind } from '../../../flows/usage-telemetry';
import { publicProcedureRaw } from '../../index';

/** A flow file becomes a new flow that starts turned off, so nothing in it runs until the user says. */
async function importFlowFile(contents: string) {
  const parsed = parseFlowFile(contents);
  if (!parsed.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.message });
  const db = getDatabase();
  const [projects, accounts] = await Promise.all([listProjects(db), listLocalIntegrations(db)]);
  const { graph, projectId, needsSetup } = localizeFlowGraph(parsed.file, {
    projects,
    accountIds: new Set(accounts.map((account) => account.id)),
  });
  const validation = validateGraph(graph, { mode: 'save' });
  if (!validation.valid) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This flow can't be imported: ${validation.errors[0]}`,
    });
  }
  const { name, description = null } = parsed.file;
  const id = await createFlowWithFirstVersion(
    db,
    { name, description, projectId, isEnabled: false, agentInvocable: false },
    graph,
  );
  trackFlowCreated({ id, triggerType: flowTriggerKind(graph), createdBy: 'import' });
  return { id, name, needsSetup };
}

export function createFlowCopyProcedures() {
  return {
    importFile: publicProcedureRaw
      .input(z.object({ contents: z.string().max(MAX_FLOW_FILE_BYTES) }))
      .mutation(({ input }) => importFlowFile(input.contents)),
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
