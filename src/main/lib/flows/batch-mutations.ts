/**
 * Batch mutation paths — small focused operations against batch_stages and
 * batch_stage_runs. Reused by the router's batch mutation procedures.
 */

import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import type { RunAttachment } from '../../../shared/types/run-attachment';
import { getDatabase } from '../db';
import { batchStageRuns, batchStages } from '../db/schema';

export type PatchStageDepsResult = {
  updated: number;
  partial?: boolean;
  succeededStageIds?: string[];
  failedStageIds?: string[];
  failures?: Array<{ stageId: string; message: string }>;
};

export async function patchBatchStageDepsLocal(
  batchId: string,
  stageDeps: Array<{ stage_id: string; depends_on_stage_ids: string[] }>,
): Promise<PatchStageDepsResult> {
  const db = getDatabase();
  let updated = 0;
  const succeeded: string[] = [];
  const failed: Array<{ stageId: string; message: string }> = [];

  // Pre-flight: load every stage in this batch so we can (a) reject any
  // stage_id outside the batch (cross-batch mutation guard), (b) reject any
  // depends_on_stage_id outside the batch, (c) reject self-dependencies, and
  // (d) reject cycles in the resulting DAG. Cloud's POST /batch-stages/deps
  // does the same up-front before any UPDATE fires.
  const stagesInBatch = await db
    .select({ id: batchStages.id })
    .from(batchStages)
    .where(eq(batchStages.batchId, batchId));
  const validStageIds = new Set(stagesInBatch.map((s) => s.id));

  for (const entry of stageDeps) {
    if (!validStageIds.has(entry.stage_id)) {
      failed.push({
        stageId: entry.stage_id,
        message: `stage ${entry.stage_id} not in batch ${batchId}`,
      });
      continue;
    }
    if (entry.depends_on_stage_ids.includes(entry.stage_id)) {
      failed.push({ stageId: entry.stage_id, message: 'self-dependency rejected' });
      continue;
    }
    const offBatchDep = entry.depends_on_stage_ids.find((id) => !validStageIds.has(id));
    if (offBatchDep) {
      failed.push({
        stageId: entry.stage_id,
        message: `depends_on stage ${offBatchDep} not in batch ${batchId}`,
      });
      continue;
    }
    try {
      const rows = await db
        .update(batchStages)
        .set({ dependsOnStageIds: entry.depends_on_stage_ids })
        // Scope by batchId so even a stage_id that survives the validStageIds
        // check (race) cannot mutate a row from another batch.
        .where(and(eq(batchStages.id, entry.stage_id), eq(batchStages.batchId, batchId)))
        .returning({ id: batchStages.id });
      if (rows.length === 0) {
        failed.push({ stageId: entry.stage_id, message: 'stage not found' });
      } else {
        succeeded.push(entry.stage_id);
        updated += 1;
      }
    } catch (e) {
      failed.push({
        stageId: entry.stage_id,
        message: e instanceof Error ? e.message : 'update failed',
      });
    }
  }

  if (failed.length === 0) return { updated };
  return {
    updated,
    partial: succeeded.length > 0,
    succeededStageIds: succeeded,
    failedStageIds: failed.map((f) => f.stageId),
    failures: failed,
  };
}

export type UpdateStageRunInput = {
  runId: string;
  label?: string;
  customInstructions?: string;
  attachments?: RunAttachment[];
  configOverrides?: Record<string, unknown>;
};

export async function updateStageRunLocal(
  input: UpdateStageRunInput,
): Promise<{ run: { id: string; trigger_context: Record<string, unknown> } }> {
  const db = getDatabase();
  const [existing] = await db
    .select()
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, input.runId))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }
  const tc: Record<string, unknown> =
    (existing.triggerContext as Record<string, unknown> | null) ?? {};
  const next: Record<string, unknown> = { ...tc };
  if (input.label !== undefined) next.label = input.label;
  if (input.customInstructions !== undefined) next.customInstructions = input.customInstructions;
  if (input.attachments !== undefined) next.attachments = input.attachments;
  if (input.configOverrides !== undefined) {
    next._config = {
      ...(typeof tc._config === 'object' && tc._config !== null
        ? (tc._config as Record<string, unknown>)
        : {}),
      ...input.configOverrides,
    };
  }
  await db
    .update(batchStageRuns)
    .set({ triggerContext: next })
    .where(eq(batchStageRuns.id, input.runId));
  return { run: { id: input.runId, trigger_context: next } };
}

export async function reassignStageRunLocal(
  runId: string,
  targetStageId: string,
): Promise<{ runId: string; sourceStageId: string; targetStageId: string }> {
  const db = getDatabase();
  const [existing] = await db
    .select({ stageId: batchStageRuns.stageId })
    .from(batchStageRuns)
    .where(eq(batchStageRuns.id, runId))
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
  }
  const sourceStageId = existing.stageId;
  if (sourceStageId === targetStageId) {
    return { runId, sourceStageId, targetStageId };
  }
  const [target] = await db
    .select({ id: batchStages.id })
    .from(batchStages)
    .where(eq(batchStages.id, targetStageId))
    .limit(1);
  if (!target) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Target stage not found' });
  }
  await db
    .update(batchStageRuns)
    .set({ stageId: targetStageId })
    .where(eq(batchStageRuns.id, runId));
  return { runId, sourceStageId, targetStageId };
}
