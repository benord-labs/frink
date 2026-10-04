/**
 * Batch dispatch context — resolves everything a batch needs from its flow
 * version (pinned version, concurrency limit, declared trigger variables) for
 * batch-dispatch.ts.
 */

import { TRPCError } from '@trpc/server';
import log from 'electron-log';
import type { BatchTriggerSchemaItem } from '../../../shared/types/flow-settings-schema';
import type { getDatabase } from '../db';
import { cancelUndispatchedRunsForStage } from '../db/repos/batch-stage-runs';
import { listStagesForBatch, setStageStatusIf } from '../db/repos/batch-stages';
import { getEarliestRunForBatch } from '../db/repos/flow-runs';
import { getLatestVersion, getVersion } from '../db/repos/flow-versions';
import { getFlowById } from '../db/repos/flows';
import type { BatchStage, FlowRun, FlowVersion } from '../db/schema';
import { emitBatchCompleted } from './event-emit';
import { parseGraph } from './graph';

type Db = ReturnType<typeof getDatabase>;

export const TERMINAL_STAGE_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// --- Whole-batch terminal detection -------------------------------------
// Called by batch-dispatch after any stage finalization; emits
// batch_completed iff every stage in the batch is now terminal.
// Emission is per-TRANSITION into all-terminal: `announced` marks the current
// arrival so nested/concurrent settles observing the same one (a promoted
// empty successor finalizes synchronously inside its promoter; parallel roots
// finish together) collapse to one emission, and any activity on the batch
// re-arms it — so a rerun re-fires however quickly it re-terminalizes (the
// user reran — they want the landing).
const announcedBatches = new Set<string>();

/** A stage is active again (dispatch/settle on a running batch) — re-arm. */
export function rearmBatchCompleted(batchId: string): void {
  announcedBatches.delete(batchId);
}

export async function maybeEmitBatchCompleted(
  db: Db,
  batchId: string,
  flowId: string,
): Promise<void> {
  const stages = await listStagesForBatch(db, batchId);
  if (stages.length === 0) return;
  if (!stages.every((s) => TERMINAL_STAGE_STATUSES.has(s.status))) return;
  // Check-and-mark is synchronous (no await below), so concurrent observers
  // of the same arrival cannot both pass.
  if (announcedBatches.has(batchId)) return;
  announcedBatches.add(batchId);

  const flow = await getFlowById(db, flowId);
  const verdict = stages.every((s) => s.status === 'completed') ? 'completed' : 'failed';
  emitBatchCompleted({ flowId, flowName: flow?.name ?? 'Batch' }, batchId, verdict);
}

export function stageDeps(stage: BatchStage): string[] {
  return Array.isArray(stage.dependsOnStageIds) ? (stage.dependsOnStageIds as string[]) : [];
}

/** Pending roots, plus pending stages whose deps all exist and completed — defined after those deps
 * finished, so successor promotion never saw them. */
export function startableStages(stages: BatchStage[]): {
  roots: BatchStage[];
  startable: BatchStage[];
} {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const roots = stages.filter((s) => stageDeps(s).length === 0);
  const lateReady = stages.filter((s) => {
    const deps = stageDeps(s);
    return deps.length > 0 && deps.every((id) => byId.get(id)?.status === 'completed');
  });
  return { roots, startable: [...roots, ...lateReady].filter((s) => s.status === 'pending') };
}

export function evaluateDepGate(
  stage: BatchStage,
  byId: Map<string, BatchStage>,
): 'ready' | 'blocked' | 'orphaned' {
  const deps = stageDeps(stage)
    .map((id) => byId.get(id))
    .filter((d): d is BatchStage => Boolean(d));
  if (deps.every((d) => d.status === 'completed')) return 'ready';
  return deps.every((d) => TERMINAL_STAGE_STATUSES.has(d.status)) ? 'orphaned' : 'blocked';
}

const CASCADE_ROUND_LIMIT = 50;

/** Fixpoint cancel of pending stages whose deps are all terminal but not all completed.
 * One DAG layer per round, so it converges in O(depth) rounds. */
export async function cascadeCancelBlockedStages(db: Db, batchId: string): Promise<void> {
  for (let round = 0; round < CASCADE_ROUND_LIMIT; round += 1) {
    const stages = await listStagesForBatch(db, batchId);
    const byId = new Map(stages.map((s) => [s.id, s]));
    const blocked = stages.filter((s) => {
      if (s.status !== 'pending') return false;
      const deps = stageDeps(s)
        .map((id) => byId.get(id))
        .filter((d): d is BatchStage => Boolean(d));
      if (deps.length === 0) return false;
      return (
        deps.every((d) => TERMINAL_STAGE_STATUSES.has(d.status)) &&
        deps.some((d) => d.status !== 'completed')
      );
    });
    if (blocked.length === 0) return;
    for (const stage of blocked) {
      if (await setStageStatusIf(db, stage.id, 'pending', 'cancelled')) {
        await cancelUndispatchedRunsForStage(db, stage.id);
      }
    }
  }
  log.warn('[BatchDispatch] cascade cancel hit round limit — deep stages may stay pending', {
    batchId,
    rounds: CASCADE_ROUND_LIMIT,
  });
}

/**
 * Per-stage in-flight ceiling when graph.settings.maxBatchConcurrency is unset.
 * Matches the documented worker ceiling in mcp/flows-tools/guidelines/
 * batching-rate-limits.ts — maxBatchConcurrency can only cap below it.
 */
const BATCH_DISPATCH_CEILING = 5;

export type BatchCtx = {
  flowId: string;
  flowVersionId: string;
  batchId: string;
  limit: number;
  declaredTriggerSchema: BatchTriggerSchemaItem[];
};

export function buildCtx(version: FlowVersion, batchId: string): BatchCtx {
  const settings = parseGraph(version.graph).settings ?? {};
  const max = settings.maxBatchConcurrency;
  const limit =
    typeof max === 'number' && Number.isInteger(max) && max >= 1
      ? Math.min(max, BATCH_DISPATCH_CEILING)
      : BATCH_DISPATCH_CEILING;
  const declared = settings.batchTriggerSchema;
  return {
    flowId: version.flowId,
    flowVersionId: version.id,
    batchId,
    limit,
    declaredTriggerSchema: Array.isArray(declared) ? (declared as BatchTriggerSchemaItem[]) : [],
  };
}

/** Pin the version the batch runs against: earliest run's version, else the flow's latest. */
export async function resolveBatchCtx(db: Db, flowId: string, batchId: string): Promise<BatchCtx> {
  const flow = await getFlowById(db, flowId);
  if (!flow) throw new TRPCError({ code: 'NOT_FOUND', message: 'Flow not found' });
  const earliest = await getEarliestRunForBatch(db, batchId);
  const version = earliest
    ? await getVersion(db, earliest.flowVersionId)
    : await getLatestVersion(db, flowId);
  if (!version) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Flow has no saved version — save a version before starting a batch.',
    });
  }
  return buildCtx(version, batchId);
}

/** A batch records its flow only through its runs: null before the first run or under another
 * flow, when nothing may be dispatched for it on this flow's behalf. */
export async function ctxIfOwnedBatch(
  db: Db,
  flowId: string,
  batchId: string,
): Promise<BatchCtx | null> {
  const earliest = await getEarliestRunForBatch(db, batchId);
  if (!earliest) return null;
  const ctx = await ctxFromRun(db, earliest);
  return ctx?.flowId === flowId ? ctx : null;
}

/** Ctx from a batch run's own pinned version — the event/recovery path has no session. */
export async function ctxFromRun(db: Db, run: FlowRun): Promise<BatchCtx | null> {
  if (!run.batchId) return null;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return null;
  return buildCtx(version, run.batchId);
}

const TRIGGER_TYPE_CHECKS: Record<BatchTriggerSchemaItem['type'], (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  object: (value) => typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
};

/**
 * Type-check trigger_context values against the flow's declared batchTriggerSchema.
 * Declared keys are optional variables — only a present key with a mismatched type
 * fails (we refuse to spawn an agent on a context the flow's templates can't consume).
 */
export function validateDeclaredTriggerTypes(
  declared: BatchTriggerSchemaItem[],
  triggerContext: Record<string, unknown> | null,
): string | null {
  if (!triggerContext) return null;
  for (const item of declared) {
    const value = triggerContext[item.key];
    if (value === undefined || value === null) continue;
    if (!TRIGGER_TYPE_CHECKS[item.type](value)) {
      return `trigger.${item.key} expected ${item.type}, got ${Array.isArray(value) ? 'array' : typeof value}`;
    }
  }
  return null;
}
