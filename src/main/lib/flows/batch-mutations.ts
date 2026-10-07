/**
 * Batch mutation paths — small focused operations against batch_stages and
 * batch_stage_runs. Reused by the router's batch mutation procedures.
 */

import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, ne, notExists } from 'drizzle-orm';
import type { RunAttachment } from '../../../shared/types/run-attachment';
import { getDatabase } from '../db';
import { ACTIVE_BSR_STATUSES } from '../db/repos/batch-stage-runs';
import { batchStageRuns, batchStages, flowRuns, flowVersions } from '../db/schema';
import { ctxIfOwnedBatch } from './batch-context';
import { resettleStagesAfterMove } from './batch-dispatch';

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

/** Stages a pending run may move between: a finished one neither releases nor dispatches a run. */
const REASSIGNABLE_STAGE_STATUSES: readonly string[] = ['pending', 'running'];

type ReassignResult = { runId: string; sourceStageId: string; targetStageId: string };

/** Checks and move share ONE synchronous transaction so admission cannot interleave: a run that
 * already holds a slot or a flow_run link keeps the stage its terminal event will settle. */
function moveStageRun(
  flowId: string,
  runId: string,
  targetStageId: string,
): ReassignResult & { batchId: string } {
  const db = getDatabase();
  return db.transaction(() => {
    const existing = db
      .select({
        stageId: batchStageRuns.stageId,
        batchId: batchStages.batchId,
        stageStatus: batchStages.status,
      })
      .from(batchStageRuns)
      .innerJoin(batchStages, eq(batchStages.id, batchStageRuns.stageId))
      .where(eq(batchStageRuns.id, runId))
      .get();
    if (!existing) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Stage run not found' });
    }
    // Checked in the move's own transaction: a first run for another flow cannot land in between.
    const foreign = db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
      .where(and(eq(flowRuns.batchId, existing.batchId), ne(flowVersions.flowId, flowId)))
      .limit(1)
      .get();
    if (foreign) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Batch not found for this flow' });
    }
    const moved = {
      runId,
      sourceStageId: existing.stageId,
      targetStageId,
      batchId: existing.batchId,
    };
    if (existing.stageId === targetStageId) return moved;
    // A cancelled source cancels its pending runs a tick later; one must not escape into a live stage.
    if (!REASSIGNABLE_STAGE_STATUSES.includes(existing.stageStatus)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This stage has already finished' });
    }
    const target = db
      .select({ status: batchStages.status })
      .from(batchStages)
      .where(and(eq(batchStages.id, targetStageId), eq(batchStages.batchId, existing.batchId)))
      .get();
    if (!target) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Target stage not found' });
    }
    if (!REASSIGNABLE_STAGE_STATUSES.includes(target.status)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Target stage has already finished' });
    }
    const updated = db
      .update(batchStageRuns)
      .set({ stageId: targetStageId })
      .where(
        and(
          eq(batchStageRuns.id, runId),
          eq(batchStageRuns.status, 'pending'),
          isNull(batchStageRuns.flowRunId),
        ),
      )
      .returning({ id: batchStageRuns.id })
      .get();
    if (!updated) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Only pending runs can be moved' });
    }
    return moved;
  });
}

/** Running stages of the batch with nothing active left: a move whose re-settle failed leaves its
 * source among them, and nothing else will finalize it before a restart. One query, not one per stage. */
function quiescentRunningStageIds(batchId: string): string[] {
  const db = getDatabase();
  return db
    .select({ id: batchStages.id })
    .from(batchStages)
    .where(
      and(
        eq(batchStages.batchId, batchId),
        eq(batchStages.status, 'running'),
        notExists(
          db
            .select({ id: batchStageRuns.id })
            .from(batchStageRuns)
            .where(
              and(
                eq(batchStageRuns.stageId, batchStages.id),
                inArray(batchStageRuns.status, [...ACTIVE_BSR_STATUSES]),
              ),
            ),
        ),
      ),
    )
    .all()
    .map((row) => row.id);
}

export async function reassignStageRunLocal(
  flowId: string,
  runId: string,
  targetStageId: string,
): Promise<ReassignResult> {
  const { batchId, ...moved } = moveStageRun(flowId, runId, targetStageId);
  const ctx = await ctxIfOwnedBatch(getDatabase(), flowId, batchId);
  if (!ctx) return moved;
  // A repeated move is a no-op here, so it is the retry path for a re-settle that failed: the old
  // source is unknown by then, so settle whichever running stages were left with nothing active.
  const stageIds =
    moved.sourceStageId === targetStageId
      ? [targetStageId, ...quiescentRunningStageIds(batchId)]
      : [moved.sourceStageId, targetStageId];
  await resettleStagesAfterMove(ctx, [...new Set(stageIds)]);
  return moved;
}
