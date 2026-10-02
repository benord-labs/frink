/**
 * Local SQLite counterpart of the cloud batch signal bridge; terminal events drive DAG advancement.
 * Eligible BSRs move pending → queued → dispatched through machine-wide admission.
 *
 * Restart safety: dispatched runs use idempotencyKey = bsr.id, and
 * recoverBatchStages() (called from scheduler.recoverOrphans) settles BSRs
 * whose runs were terminalized without an event.
 */

import log from 'electron-log';
import type { StartBatchResult } from '../../../shared/types/flows/flow-batch';
import { getDatabase } from '../db';
import {
  ACTIVE_BSR_STATUSES,
  type BatchStageRunStatus,
  cancelUndispatchedRunsForStage,
  getBatchStageRun,
  getStageRunByFlowRunId,
  listActiveStageRuns,
  listRunsForStage,
  setStageRunStatus,
  setStageRunStatusIf,
} from '../db/repos/batch-stage-runs';
import {
  getBatchStage,
  listStagesByStatus,
  listStagesForBatch,
  reopenCascadedSuccessor,
  setStageStatusIf,
  settleStageIfQuiescent,
} from '../db/repos/batch-stages';
import {
  getEarliestRunForBatch,
  getFlowRun,
  getFlowRunByIdempotencyKey,
} from '../db/repos/flow-runs';
import { getVersion } from '../db/repos/flow-versions';
import type { BatchStage, BatchStageRun } from '../db/schema';
import { captureFlowAdmissionException, withFlowResourceCleanup } from './admission/activity';
import {
  occupiedStageSlots,
  settleTerminalBatchReplay,
  StageAtConcurrencyLimitError,
} from './admission/batch-promotion';
import {
  type BatchCtx,
  buildCtx,
  ctxFromRun,
  evaluateDepGate,
  maybeEmitBatchCompleted,
  rearmBatchCompleted,
  resolveBatchCtx,
  stageDeps,
  startableStages,
  TERMINAL_STAGE_STATUSES,
  validateDeclaredTriggerTypes,
} from './batch-context';
import { mergeDependencyBranches, resolveDependencyBranches } from './batch';
import { subscribeFlowEvents } from './events';
import { startFlowRun } from './start';

type Db = ReturnType<typeof getDatabase>;

const CASCADE_ROUND_LIMIT = 50;

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * A pending BSR linked to a terminal flow_run is ambiguous begun work, not a first dispatch.
 * Never replay it automatically; fail the BSR so recovery stays at-most-once. Returns 0 when
 * settled here, or null to fall through to a fresh dispatch.
 */
async function tryRedispatchExistingRun(db: Db, bsr: BatchStageRun): Promise<number | null> {
  if (!bsr.flowRunId) return null;
  const existing = await getFlowRun(db, bsr.flowRunId);
  if (!existing || !TERMINAL_RUN_STATUSES.has(existing.status)) return null;
  await setStageRunStatusIf(db, bsr.id, ['pending'], 'failed');
  return 0;
}

const needsLegacyBatchLink = (isReplay: boolean, runStatus: string): boolean =>
  isReplay && runStatus !== 'pending';

/**
 * Create flow_runs for a stage's pending BSRs up to the open concurrency slots.
 * Returns inFlight (newly dispatched, still running) and progressed (any BSR
 * state change — dispatched, failed-at-dispatch, or settled from a replayed
 * terminal run) so settleStage can decide whether to recount.
 */
async function dispatchPendingStageRun(
  db: Db,
  bsr: BatchStageRun,
  stageId: string,
  ctx: BatchCtx,
  inheritedBranches: string[],
): Promise<{ inFlight: number; progressed: number }> {
  const reran = await tryRedispatchExistingRun(db, bsr);
  if (reran !== null) return { inFlight: reran, progressed: 1 };
  // Injected before validation so a declared schema also checks the inherited keys.
  const triggerContext = mergeDependencyBranches(
    (bsr.triggerContext as Record<string, unknown> | null) ?? null,
    inheritedBranches,
  );
  const typeError = validateDeclaredTriggerTypes(ctx.declaredTriggerSchema, triggerContext);
  if (typeError) {
    await setStageRunStatusIf(db, bsr.id, ['pending'], 'failed');
    log.warn('[BatchDispatch] stage run failed trigger-context validation', {
      stageRunId: bsr.id,
      stageId,
      typeError,
    });
    return { inFlight: 0, progressed: 1 };
  }
  try {
    const { run, isReplay } = await startFlowRun({
      flowId: ctx.flowId,
      triggerContext,
      idempotencyKey: bsr.id,
      flowVersionId: ctx.flowVersionId,
      batchId: ctx.batchId,
      batchStageRunId: bsr.id,
    });
    if (await settleTerminalBatchReplay(db, bsr, run, isReplay)) {
      // Crash-replay of an already-finished run has no new terminal event.
      return { inFlight: 0, progressed: 1 };
    }
    if (needsLegacyBatchLink(isReplay, run.status)) {
      // A legacy replay may predate admission and still needs its BSR link repaired.
      await setStageRunStatusIf(db, bsr.id, ['pending'], 'dispatched', run.id);
    }
    return { inFlight: 1, progressed: 1 };
  } catch (err) {
    if (err instanceof StageAtConcurrencyLimitError) {
      // A resume promotion took the last slot between this loop's check and the enqueue: the member
      // stays pending and the next settle dispatches it. Captured so a hot stage is visible.
      captureFlowAdmissionException(err, 'batch-stage-slot-race');
      log.info('[BatchDispatch] stage slot taken by a resume promotion; member left pending', {
        stageRunId: bsr.id,
        stageId,
      });
      return { inFlight: 0, progressed: 0 };
    }
    await setStageRunStatusIf(db, bsr.id, ['pending'], 'failed');
    log.warn('[BatchDispatch] stage run dispatch failed', { stageRunId: bsr.id, stageId, err });
    captureFlowAdmissionException(err, 'batch-queue-promotion');
    return { inFlight: 0, progressed: 1 };
  }
}

async function dispatchStageRuns(
  db: Db,
  stage: BatchStage,
  ctx: BatchCtx,
): Promise<{ inFlight: number; progressed: number }> {
  const runs = await listRunsForStage(db, stage.id);
  const pending = runs.filter((r) => r.status === 'pending');
  // A running stage's deps are all completed, so their branches are fixed: resolve once per pass.
  const inheritedBranches = pending.length > 0 ? await resolveDependencyBranches(db, stage) : [];
  let inFlight = 0;
  let progressed = 0;
  for (const bsr of pending) {
    // Re-read per member, not sliced into one budget: a resume promotion can take a slot in its own
    // transaction while this loop awaits a dispatch, and a stale budget would overshoot the limit.
    if (occupiedStageSlots(db, stage.id) >= ctx.limit) break;
    const result = await dispatchPendingStageRun(db, bsr, stage.id, ctx, inheritedBranches);
    inFlight += result.inFlight;
    progressed += result.progressed;
  }
  return { inFlight, progressed };
}

/**
 * Drive a 'running' stage forward: slot-fill pending BSRs while work is in
 * flight; once every BSR is terminal, apply the failure threshold
 * (-1 = never block, >= 0 = fail when failedCount exceeds it), settle the
 * stage via a guarded update (mutex against concurrent terminal events), then
 * cascade-cancel or promote successors.
 */
async function settleStage(db: Db, stageId: string, ctx: BatchCtx): Promise<void> {
  for (;;) {
    const stage = await getBatchStage(db, stageId);
    if (stage?.status !== 'running') return;
    // A running stage means the batch is active again — re-arm the
    // batch_completed announcement so its next all-terminal arrival fires
    // (a rerun re-fires however quickly it re-terminalizes).
    rearmBatchCompleted(stage.batchId);

    const runs = await listRunsForStage(db, stage.id);
    const active = runs.filter((r) =>
      (ACTIVE_BSR_STATUSES as readonly string[]).includes(r.status),
    );
    if (active.length === 0) return finalizeStage(db, stage, ctx);

    const recount = await slotFill(db, stage, active, ctx);
    if (!recount) return;
  }
}

/**
 * Fill open concurrency slots from pending BSRs. Returns true when the caller
 * should recount: every dispatch settled synchronously (failed/replayed), so
 * no terminal event will drive the next settle.
 */
async function slotFill(
  db: Db,
  stage: BatchStage,
  active: Awaited<ReturnType<typeof listRunsForStage>>,
  ctx: BatchCtx,
): Promise<boolean> {
  const pendingCount = active.filter((r) => r.status === 'pending').length;
  const occupiedCount = active.length - pendingCount;
  if (pendingCount === 0 || occupiedCount >= ctx.limit) return false; // waiting on in-flight runs
  const { inFlight, progressed } = await dispatchStageRuns(db, stage, ctx);
  return inFlight === 0 && progressed > 0;
}

/** Apply the failure threshold to an all-terminal stage, then cascade or promote. */
async function finalizeStage(db: Db, stage: BatchStage, ctx: BatchCtx): Promise<void> {
  // Recount + flip in one transaction: a member re-admitted since the caller's read must not be
  // stranded under a stage that finalized from a stale snapshot.
  const settled = settleStageIfQuiescent(db, stage);
  if (!settled) return; // still active, or a concurrent settle already finalized this stage

  if (settled.failed) {
    log.info('[BatchDispatch] batch stage failed — blocking advancement', {
      stageId: stage.id,
      batchId: stage.batchId,
      failedCount: settled.failedCount,
      failureThreshold: stage.failureThreshold,
    });
    await cascadeCancelBlockedStages(db, stage.batchId);
  } else {
    await promoteSuccessors(db, stage, ctx);
  }
  // Mutex winner: the batch may have just gone all-terminal (debounce inside).
  await maybeEmitBatchCompleted(db, stage.batchId, ctx.flowId);
}

/** Start every successor whose deps are ALL completed (a cascade-cancelled one is revived); cancel a
 * successor whose deps are all terminal but not all completed, and its transitively blocked stages. */
async function promoteSuccessors(db: Db, completed: BatchStage, ctx: BatchCtx): Promise<void> {
  const stages = await listStagesForBatch(db, completed.batchId);
  const byId = new Map(stages.map((s) => [s.id, s]));
  const successors = stages.filter(
    (s) =>
      (s.status === 'pending' || s.status === 'cancelled') && stageDeps(s).includes(completed.id),
  );

  let foundOrphan = false;
  for (const successor of successors) {
    foundOrphan = (await promoteOneSuccessor(db, successor, byId, ctx)) || foundOrphan;
  }
  if (foundOrphan) await cascadeCancelBlockedStages(db, completed.batchId);
}

/** @returns true when the successor was orphan-cancelled (deps terminal, not all completed). */
async function promoteOneSuccessor(
  db: Db,
  successor: BatchStage,
  byId: Map<string, BatchStage>,
  ctx: BatchCtx,
): Promise<boolean> {
  const gate = evaluateDepGate(successor, byId);
  if (gate === 'blocked') return false; // some dep still active — a later terminal event re-evaluates

  if (gate === 'orphaned') {
    // Deps all terminal but not all completed — this successor can never run.
    const cancelled = await setStageStatusIf(db, successor.id, 'pending', 'cancelled');
    if (cancelled) await cancelUndispatchedRunsForStage(db, successor.id);
    return cancelled;
  }

  // A cascade-cancelled successor is runnable again now its deps are all completed;
  // a still-pending one is left exactly as it was.
  reopenCascadedSuccessor(db, successor.id);

  if (await setStageStatusIf(db, successor.id, 'pending', 'running')) {
    const { inFlight } = await dispatchStageRuns(db, successor, ctx);
    if (inFlight === 0) await settleStage(db, successor.id, ctx); // empty stage / all settled at dispatch
  }
  return false;
}

/**
 * Fixpoint cancel of transitively-blocked pending stages: deps all terminal
 * with at least one non-completed. One DAG layer per round; converges in
 * O(depth) rounds (cloud parity, same round cap).
 */
async function cascadeCancelBlockedStages(db: Db, batchId: string): Promise<void> {
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

/** Real local startBatch: promote pending root (and late-ready) stages and create actual flow_runs
 * for their BSRs. totalEnqueued counts runs genuinely dispatched. */
export async function startFlowBatchLocal(
  flowId: string,
  batchId: string,
): Promise<StartBatchResult> {
  const db = getDatabase();
  await cascadeCancelBlockedStages(db, batchId);
  const stages = await listStagesForBatch(db, batchId);
  if (stages.length === 0) return { started: false, reason: 'no-stages-defined' };

  const { roots, startable } = startableStages(stages);
  if (roots.length === 0) {
    return {
      started: false,
      reason: 'no-root-stages',
      totalStages: stages.length,
      rootStageCount: 0,
    };
  }
  if (startable.length === 0) {
    return {
      started: false,
      reason: 'all-roots-started',
      totalStages: stages.length,
      rootStageCount: roots.length,
    };
  }

  const ctx = await resolveBatchCtx(db, flowId, batchId);
  const startedStageNumbers: number[] = [];
  let totalEnqueued = 0;
  for (const stage of startable) {
    if (!(await setStageStatusIf(db, stage.id, 'pending', 'running'))) continue;
    startedStageNumbers.push(stage.stageNumber);
    const { inFlight } = await dispatchStageRuns(db, stage, ctx);
    totalEnqueued += inFlight;
    if (inFlight === 0) await settleStage(db, stage.id, ctx); // empty root / all settled at dispatch
  }

  if (startedStageNumbers.length === 0) {
    return {
      started: false,
      reason: 'unknown',
      totalStages: stages.length,
      rootStageCount: roots.length,
      startedRootCount: 0,
    };
  }
  return {
    started: true,
    startedStageNumbers,
    totalEnqueued,
    totalStages: stages.length,
    rootStageCount: roots.length,
    startedRootCount: roots.filter((r) => startedStageNumbers.includes(r.stageNumber)).length,
  };
}

/**
 * Settle the BSR behind a terminal flow run and advance its stage. Only
 * 'completed' counts as a pass (cancelled = failed, cloud parity). Looks the
 * BSR up by flow_run_id with an idempotencyKey fallback — the dispatch loop's
 * link UPDATE can lose the race against a fast synchronous run.
 */
export async function onBatchRunTerminal(
  flowRunId: string,
  runStatus: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const db = getDatabase();
  const run = await getFlowRun(db, flowRunId);
  if (!run?.batchId) return; // not a batch run — zero overhead for normal flows

  let bsr = await getStageRunByFlowRunId(db, flowRunId);
  if (!bsr && run.idempotencyKey) bsr = await getBatchStageRun(db, run.idempotencyKey);
  if (!bsr) return;

  await setStageRunStatusIf(
    db,
    bsr.id,
    [...ACTIVE_BSR_STATUSES],
    runStatus === 'completed' ? 'completed' : 'failed',
    run.id,
  );

  const stage = await getBatchStage(db, bsr.stageId);
  if (stage?.status !== 'running') return;
  const ctx = await ctxFromRun(db, run);
  if (!ctx) return;
  await settleStage(db, stage.id, ctx);
}

/** Subscribe stage advancement to run-terminal events. Returns the unsubscribe. */
export function startBatchAdvanceListener(): () => void {
  return subscribeFlowEvents((event) => {
    if (
      event.eventType !== 'run_completed' &&
      event.eventType !== 'run_failed' &&
      event.eventType !== 'run_cancelled'
    ) {
      return;
    }
    if (!event.flowRunId) return; // run_* events always carry a run id
    const flowRunId = event.flowRunId;
    const runStatus = event.eventType.replace('run_', '') as 'completed' | 'failed' | 'cancelled';
    const advance = withFlowResourceCleanup(flowRunId, () =>
      event.batchId ? onBatchRunTerminal(flowRunId, runStatus) : undefined,
    );
    void advance.catch((err) => {
      log.warn('[BatchDispatch] stage advance failed', { flowRunId, err });
      captureFlowAdmissionException(err, 'batch-terminal-advance');
    });
  });
}

/**
 * Startup sweep (after scheduler.recoverOrphans, which terminalizes orphaned
 * runs WITHOUT emitting events): settle BSRs whose run is terminal or missing,
 * re-link runs found by idempotencyKey, then settle every 'running' stage —
 * which also re-dispatches its still-pending BSRs.
 */
export async function recoverBatchStages(): Promise<number> {
  const db = getDatabase();
  let settled = 0;
  for (const bsr of await listActiveStageRuns(db)) {
    settled += await recoverStageRunLink(db, bsr);
  }
  for (const stage of await listStagesByStatus(db, 'running')) {
    await recoverRunningStage(db, stage);
  }
  return settled;
}

/** Settle one in-flight BSR from DB truth: run missing/terminal → settle; active → re-link. */
async function recoverStageRunLink(
  db: Db,
  bsr: Awaited<ReturnType<typeof listActiveStageRuns>>[number],
): Promise<0 | 1> {
  if (bsr.status === 'pending') return 0; // DAG/slot-blocked — re-dispatched by stage recovery
  const run = bsr.flowRunId
    ? await getFlowRun(db, bsr.flowRunId)
    : await getFlowRunByIdempotencyKey(db, bsr.id);
  if (!run) {
    await setStageRunStatusIf(db, bsr.id, ['queued', 'dispatched'], 'failed');
    return 1;
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    await setStageRunStatusIf(
      db,
      bsr.id,
      ['queued', 'dispatched'],
      run.status === 'completed' ? 'completed' : 'failed',
      run.id,
    );
    return 1;
  }
  if (!bsr.flowRunId) {
    // Run still active (paused agent) — restore the link without changing status.
    await setStageRunStatus(db, bsr.id, bsr.status as BatchStageRunStatus, run.id);
  }
  return 0;
}

async function recoverRunningStage(db: Db, stage: BatchStage): Promise<void> {
  const earliest = await getEarliestRunForBatch(db, stage.batchId);
  const version = earliest ? await getVersion(db, earliest.flowVersionId) : null;
  if (earliest && version) {
    return settleStage(db, stage.id, buildCtx(version, stage.batchId));
  }
  const runs = await listRunsForStage(db, stage.id);
  if (runs.every((r) => r.status === 'pending')) {
    // Crashed between root promotion and the first dispatch — no run exists
    // to resolve the flow from. Reset so the user can call startBatch again.
    await setStageStatusIf(db, stage.id, 'running', 'pending');
    return;
  }
  // BSRs progressed but every batch run is gone (e.g. the flow was deleted,
  // cascading flow_runs away) — fail the stage and release the DAG.
  await cancelUndispatchedRunsForStage(db, stage.id);
  if (await setStageStatusIf(db, stage.id, 'running', 'failed')) {
    await cascadeCancelBlockedStages(db, stage.batchId);
  }
}
