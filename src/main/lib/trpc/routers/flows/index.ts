/* eslint-disable max-lines, max-lines-per-function */
// tRPC router — Frink Flows (LOCAL SQLite). CRUD procedures adapt Drizzle rows to cloud-shaped
// DTOs (flows/adapters.ts); run-time procedures call the local engine (flows/engine.ts).

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  flowGraphEdgeSchema,
  flowGraphNodeSchema,
} from '../../../../../shared/types/flow-graph-schema';
import { flowSettingsSchema } from '../../../../../shared/types/flow';
import { flowResumeSnapshotSchema } from '../../../../../shared/types/flow-run/resume';
import type { BatchRunRow } from '../../../cloud/flows';
import type {
  BatchStageDetail,
  BatchSummary,
  StartBatchResult,
} from '../../../../../shared/types/flows/flow-batch';
import type { BatchStageRunRow } from '../../../../../shared/types/flow';
import { getDatabase } from '../../../db';
import {
  BatchPlanTemplateNameTakenError,
  createBatchPlanTemplate as createBatchPlanTemplateLocal,
  deleteBatchPlanTemplate as deleteBatchPlanTemplateLocal,
  listBatchPlanTemplates as listBatchPlanTemplatesLocal,
  renameBatchPlanTemplate as renameBatchPlanTemplateLocal,
} from '../../../db/repos/batch-plan-templates';
import {
  createBriefingStash as createBriefingStashLocal,
  deleteBriefingStash as deleteBriefingStashLocal,
  listBriefingStashes as listBriefingStashesLocal,
} from '../../../db/repos/briefing-stashes';
import {
  getFlowRun,
  listChatIdsWithActiveFlowRun,
  listIncompleteFlowRunIdsForChat,
} from '../../../db/repos/flow-runs';
import { createFlowVersion, getLatestVersion, getVersion } from '../../../db/repos/flow-versions';
import {
  createFlow as createFlowLocal,
  getFlowById,
  updateFlow as updateFlowLocal,
} from '../../../db/repos/flows';
import { listNodeRunsForFlowRun } from '../../../db/repos/node-runs';
import {
  toDbBatchPlanTemplate,
  toDbBriefingStash,
  toDbFlow,
  toDbFlowRunWithNodeRuns,
  toDbFlowVersion,
  toDbFlowWithLatestVersion,
} from '../../../flows/adapters';
import { flowRunAdmissionSnapshotsForRuns } from '../../../flows/admission/visibility';
import { validateDag } from '../../../flows/dag-validation';
import {
  cancelFlowRun as cancelFlowRunLocal,
  getFlowRunWithNodeRuns,
  rerunFlowRunFromInterruption as rerunFlowRunLocal,
  resumeFlowRun as resumeFlowRunLocal,
  startFlowRun as startFlowRunLocal,
} from '../../../flows/engine';
import { describeInterruptedRunForChat, pauseFlowRunForSubChat } from '../../../flows/resume';
import { pauseActiveExecutionForSubChat } from '../../../socket/executor';
// Flows use snake_case DTOs end-to-end (cloud-API contract); opt out of the
// global snake_case→camelCase output middleware. See publicProcedureRaw.
import { publicProcedureRaw, router } from '../../index';
import { flowAdmissionQueueProcedures } from './admission-queue';
import { flowAdmissionSettingsProcedures } from './admission-settings';
import { createFlowCopyProcedures } from './copy';
import { createFlowListProcedures, flowGraphMeta } from './list';
import { flowStartResponse, mapEngineError, retrySettledFlowRun } from './run-actions';

const flowGraphSchema = z.object({
  nodes: z.array(flowGraphNodeSchema),
  edges: z.array(flowGraphEdgeSchema),
  settings: flowSettingsSchema,
});
export const flowsRouter = router({
  ...createFlowListProcedures(),
  ...createFlowCopyProcedures(),
  ...flowAdmissionQueueProcedures(),
  get: publicProcedureRaw.input(z.object({ id: z.string().min(1) })).query(async ({ input }) => {
    const db = getDatabase();
    const row = await getFlowById(db, input.id);
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
    const version = await getLatestVersion(db, row.id);
    return toDbFlowWithLatestVersion(row, version, flowGraphMeta(version));
  }),

  // True while a flow run linked to this chat has not fully completed (still pending/running/paused,
  // OR failed/cancelled). Used to suppress chat rollback until the whole flow truly finishes —
  // rolling back a mid-flow or failed run rewinds the transcript/code but leaves the flow graph's
  // node_runs desynced. Only a 'completed' run re-enables rollback.
  hasIncompleteRunForChat: publicProcedureRaw
    .input(z.object({ chatId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = getDatabase();
      const ids = await listIncompleteFlowRunIdsForChat(db, input.chatId);
      return ids.length > 0;
    }),
  // Drives the in-chat interrupted-run row (describeInterruptedRunForChat owns the rules). Note the
  // sub-chat scope: the run is chat-wide, but only the tab whose session drives the interrupted node
  // can be woken by a message — the rest resolve `redispatch`. Polled like hasIncompleteRunForChat.
  interruptedRunForChat: publicProcedureRaw
    .input(z.object({ chatId: z.string().min(1), subChatId: z.string().min(1) }))
    .query(({ input }) => describeInterruptedRunForChat(input.chatId, input.subChatId)),

  // chatIds that have a non-terminal flow_run — the sidebar polls this to keep a 'Run' badge on a
  // running flow's chat even in taskless windows (pre-first-agent, non-agent nodes) where no tracked
  // task drives it. Fill-blank only in the renderer; never overrides a real task status.
  activeRunChatIds: publicProcedureRaw.query(async () => {
    return listChatIdsWithActiveFlowRun(getDatabase());
  }),

  ...flowAdmissionSettingsProcedures,
  create: publicProcedureRaw
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).nullable().optional(),
        projectId: z.string().min(1).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = await createFlowLocal(db, {
        name: input.name,
        description: input.description ?? null,
        projectId: input.projectId ?? null,
      });
      return toDbFlow(row);
    }),

  update: publicProcedureRaw
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        is_enabled: z.boolean().optional(),
        agent_invocable: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = await updateFlowLocal(db, input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.is_enabled !== undefined ? { isEnabled: input.is_enabled } : {}),
        ...(input.agent_invocable !== undefined ? { agentInvocable: input.agent_invocable } : {}),
      });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
      return toDbFlow(row);
    }),

  delete: publicProcedureRaw
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { deleteFlow: deleteFlowLocal } = await import('../../../flows/deletion');
      if (!(await deleteFlowLocal(input.id))) throw new TRPCError({ code: 'NOT_FOUND' });
      return { ok: true as const };
    }),

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
        const row = await createFlowVersion(db, {
          flowId: input.flowId,
          graph: input.graph,
          expectedVersionNumber: input.expectedVersionNumber,
        });
        return toDbFlowVersion(row);
      } catch (e) {
        mapEngineError(e);
      }
    }),

  startRun: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        triggerContext: z.record(z.string(), z.unknown()).nullable().optional(),
        idempotencyKey: z.string().min(1).max(512).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const { run, version } = await startFlowRunLocal({
          flowId: input.flowId,
          triggerContext: input.triggerContext ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        });
        return { ...flowStartResponse(getDatabase(), run), version_number: version.versionNumber };
      } catch (e) {
        mapEngineError(e);
      }
    }),

  getRun: publicProcedureRaw
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await getFlowRunWithNodeRuns(input.runId);
      if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
      const db = getDatabase();
      const version = await getVersion(db, detail.run.flowVersionId);
      const graph = version?.graph ?? null;
      const snapshot = flowRunAdmissionSnapshotsForRuns(db, [detail.run.id]).get(detail.run.id);
      const run = { ...detail.run, status: snapshot?.runStatus ?? detail.run.status };
      return toDbFlowRunWithNodeRuns(run, detail.nodeRuns, graph, snapshot?.admission ?? null);
    }),

  cancelRun: publicProcedureRaw
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const updated = await cancelFlowRunLocal(input.runId);
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
      const db = getDatabase();
      const nodeRuns = await listNodeRunsForFlowRun(db, updated.id);
      const version = await getVersion(db, updated.flowVersionId);
      return toDbFlowRunWithNodeRuns(updated, nodeRuns, version?.graph ?? null);
    }),

  pauseRun: publicProcedureRaw
    .input(z.object({ subChatId: z.string().min(1) }))
    .mutation(async ({ input }) =>
      pauseFlowRunForSubChat(input.subChatId, pauseActiveExecutionForSubChat),
    ),

  resumeRun: publicProcedureRaw
    .input(
      z.object({
        runId: z.string().min(1),
        action: z.enum(['approve', 'retry', 'skip']),
        nodeRunId: z.string().min(1),
        expectedSnapshot: flowResumeSnapshotSchema.optional(),
      }),
    )
    .mutation(async ({ input: { runId, action, nodeRunId, expectedSnapshot } }) => {
      try {
        await resumeFlowRunLocal(runId, action, nodeRunId, expectedSnapshot);
        const detail = await getFlowRunWithNodeRuns(runId);
        if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
        const version = await getVersion(getDatabase(), detail.run.flowVersionId);
        return toDbFlowRunWithNodeRuns(detail.run, detail.nodeRuns, version?.graph ?? null);
      } catch (e) {
        mapEngineError(e);
      }
    }),

  rerunRun: publicProcedureRaw
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await rerunFlowRunLocal(input.runId);
        const detail = await getFlowRunWithNodeRuns(input.runId);
        if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
        const db = getDatabase();
        const version = await getVersion(db, detail.run.flowVersionId);
        return toDbFlowRunWithNodeRuns(detail.run, detail.nodeRuns, version?.graph ?? null);
      } catch (e) {
        mapEngineError(e);
      }
    }),

  retryRunFromLastNode: publicProcedureRaw
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const run = await getFlowRun(db, input.runId);
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow run not found' });
      if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'completed') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Flow run is ${run.status}; retry requires a settled run — use Carry on instead.`,
        });
      }
      const ok = await retrySettledFlowRun(db, input.runId);
      if (!ok) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Flow run context unavailable; flow or version may have been deleted.',
        });
      }
      return { ok: true };
    }),

  // ============ BATCH PROCEDURES ============

  startBatch: publicProcedureRaw
    .input(z.object({ flowId: z.string().min(1), batchId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<StartBatchResult> => {
      const { startFlowBatchLocal } = await import('../../../flows/batch-dispatch');
      return startFlowBatchLocal(input.flowId, input.batchId);
    }),

  listBatches: publicProcedureRaw
    .input(
      z.object({ flowId: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
    )
    .query(async ({ input }): Promise<BatchSummary[]> => {
      const { listBatchSummaries } = await import('../../../flows/batch-summaries');
      return listBatchSummaries(input.flowId, input.limit ?? 20);
    }),

  listBatchRuns: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        batchId: z.string().min(1),
        status: z.string().optional(),
        stageId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }): Promise<{ runs: BatchRunRow[]; total: number }> => {
      const { listBatchRunsForBatch } = await import('../../../flows/batch-runs-list');
      return listBatchRunsForBatch(input.batchId, {
        status: input.status,
        stageId: input.stageId,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  listBatchStages: publicProcedureRaw
    .input(z.object({ flowId: z.string().min(1), batchId: z.string().min(1) }))
    .query(async ({ input }): Promise<{ stages: BatchStageDetail[] }> => {
      const { listBatchStageDetail } = await import('../../../flows/batch-stage-detail');
      const stages = await listBatchStageDetail(input.batchId);
      return { stages };
    }),

  patchBatchStageDeps: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        batch_id: z.string().min(1),
        stages: z.array(
          z.object({
            stage_id: z.string().min(1),
            depends_on_stage_ids: z.array(z.string().min(1)),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const { patchBatchStageDepsLocal } = await import('../../../flows/batch-mutations');
      return patchBatchStageDepsLocal(input.batch_id, input.stages);
    }),

  getBriefings: publicProcedureRaw
    .input(z.object({ projectId: z.string().min(1).nullable().optional() }).optional())
    .query((): Array<{ id: string; name: string; briefing: string }> => []),

  listStashes: publicProcedureRaw.query(async () => {
    const db = getDatabase();
    const rows = await listBriefingStashesLocal(db);
    return rows.map(toDbBriefingStash);
  }),

  createStash: publicProcedureRaw
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        content: z
          .string()
          .max(10000)
          .refine((s) => s.trim().length > 0, { message: 'content must be a non-empty string' }),
        sourceFlowId: z.string().min(1).nullable().optional(),
        sourceFlowName: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = await createBriefingStashLocal(db, {
        name: input.name,
        content: input.content,
        sourceFlowId: input.sourceFlowId ?? null,
        sourceFlowName: input.sourceFlowName ?? null,
      });
      return toDbBriefingStash(row);
    }),

  deleteStash: publicProcedureRaw
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      await deleteBriefingStashLocal(db, input.id);
      return { ok: true as const };
    }),

  listBatchPlanTemplates: publicProcedureRaw
    .input(z.object({ flowId: z.string().min(1).optional() }).optional())
    .query(async () => {
      const db = getDatabase();
      const rows = await listBatchPlanTemplatesLocal(db);
      return rows.map(toDbBatchPlanTemplate);
    }),

  createBatchPlanTemplate: publicProcedureRaw
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          stages: z
            .array(
              z.object({
                stageNumber: z.number().int().min(1),
                name: z.string().nullable(),
                dependsOn: z.array(z.number().int().min(1)),
              }),
            )
            .min(1)
            .max(50),
          sourceFlowId: z.string().min(1).optional(),
        })
        .superRefine((data, ctx) => {
          const dagInput = data.stages.map((s) => ({
            stageNumber: s.stageNumber,
            dependsOn: s.dependsOn,
          }));
          const dag = validateDag(dagInput);
          if (!dag.valid) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: dag.error,
              path: dag.invalidIndex !== undefined ? ['stages', dag.invalidIndex] : ['stages'],
            });
          }
        }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = await createBatchPlanTemplateLocal(db, {
        name: input.name,
        stages: input.stages,
        sourceFlowId: input.sourceFlowId ?? null,
      });
      return toDbBatchPlanTemplate(row);
    }),

  renameBatchPlanTemplate: publicProcedureRaw
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase();
      const row = await renameBatchPlanTemplateLocal(db, input.id, input.name).catch((error) => {
        if (error instanceof BatchPlanTemplateNameTakenError) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
        }
        throw error;
      });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
      return toDbBatchPlanTemplate(row);
    }),

  deleteBatchPlanTemplate: publicProcedureRaw
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDatabase();
      await deleteBatchPlanTemplateLocal(db, input.id);
      return { ok: true as const };
    }),

  listBatchStageRuns: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        stageId: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(async ({ input }): Promise<{ runs: BatchStageRunRow[]; total: number }> => {
      const { listBatchStageRunsForStage } = await import('../../../flows/batch-stage-runs-list');
      return listBatchStageRunsForStage(input.stageId, {
        limit: input.limit,
        offset: input.offset,
      });
    }),

  updateStageRun: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        runId: z.string().min(1),
        label: z.string().optional(),
        customInstructions: z.string().max(10_000).optional(),
        attachments: z
          .array(
            z.object({
              url: z.string().min(1).max(2048),
              type: z.string().min(1),
              label: z.string().optional(),
              mimeType: z.string().optional(),
            }),
          )
          .max(10)
          .optional(),
        configOverrides: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { updateStageRunLocal } = await import('../../../flows/batch-mutations');
      return updateStageRunLocal({
        runId: input.runId,
        label: input.label,
        customInstructions: input.customInstructions,
        attachments: input.attachments,
        configOverrides: input.configOverrides,
      });
    }),

  reassignStageRun: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        runId: z.string().min(1),
        targetStageId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { reassignStageRunLocal } = await import('../../../flows/batch-mutations');
      return reassignStageRunLocal(input.flowId, input.runId, input.targetStageId);
    }),

  fetchAttachmentDataUrl: publicProcedureRaw
    .input(z.object({ url: z.string().min(1) }))
    .query(async ({ input }): Promise<{ dataUrl: string }> => {
      const { resolveAttachmentToDataUrl } = await import('../../../flows/attachments-data-url');
      const result = await resolveAttachmentToDataUrl(input.url);
      if (!result.ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: result.message });
      }
      return { dataUrl: result.dataUrl };
    }),

  uploadAndAttachImage: publicProcedureRaw
    .input(
      z.object({
        flowId: z.string().min(1),
        runId: z.string().min(1),
        data: z.string().min(1),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
      }),
    )
    .mutation(
      async ({
        input,
      }): Promise<{
        url: string;
        filename: string;
        run: { id: string; trigger_context: Record<string, unknown> };
      }> => {
        const { uploadAttachmentToStageRun } = await import('../../../flows/attachments-upload');
        return uploadAttachmentToStageRun(input);
      },
    ),
});
