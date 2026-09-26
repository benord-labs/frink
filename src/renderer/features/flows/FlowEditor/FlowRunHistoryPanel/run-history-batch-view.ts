/**
 * Pure helpers for batch grouping in the run history panel.
 * Ensures every loaded run with a batch_id has a BatchSummary (synthetic if API omitted it, e.g. listBatches limit).
 */

import type { BatchSummary } from '../../../../../shared/types/flows/flow-batch';
import type { DbFlowRun } from '../../../../../shared/types/flow-run';

const ACTIVE_STATUSES = new Set(['running', 'paused', 'pending']);
const ERROR_STATUSES = new Set(['failed', 'cancelled']);

type RunHistoryBatchView = {
  batched: BatchSummary[];
  unbatched: DbFlowRun[];
  batchedRunsMap: Map<string, DbFlowRun[]>;
  ordinalMap: Map<string, number>;
};

function maxActivityAtIso(runs: DbFlowRun[]): string | null {
  let max = -Infinity;
  let out: string | null = null;
  for (const r of runs) {
    const end = r.completed_at ?? r.started_at;
    if (!end) continue;
    const t = new Date(end).getTime();
    if (t > max) {
      max = t;
      out = end;
    }
  }
  return out;
}

/** Aggregate counts from loaded runs only — used when GET /batches omitted this batch_id (e.g. limit). */
export function syntheticBatchSummaryFromRuns(batchId: string, runs: DbFlowRun[]): BatchSummary {
  const completed = runs.filter((r) => r.status === 'completed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const running = runs.filter((r) => r.status === 'running').length;
  const errored = runs.filter((r) => ERROR_STATUSES.has(r.status)).length;
  const active = runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length;
  const startedTimes = runs
    .map((r) => r.started_at)
    .filter((t): t is string => t != null && t.length > 0)
    .map((t) => new Date(t).getTime());
  const firstRunAt =
    startedTimes.length > 0 ? new Date(Math.min(...startedTimes)).toISOString() : null;
  const lastActivityAt = maxActivityAtIso(runs);
  return {
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    batch_id: batchId,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    run_count: runs.length,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    completed_count: completed,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    failed_count: failed,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    errored_count: errored,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    running_count: running,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    active_count: active,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    first_run_at: firstRunAt,
    // biome-ignore lint/style/useNamingConvention: BatchSummary API shape uses snake_case
    last_activity_at: lastActivityAt,
  };
}

function firstRunTimeMs(s: BatchSummary): number {
  if (!s.first_run_at) return Number.POSITIVE_INFINITY;
  return new Date(s.first_run_at).getTime();
}

/** Oldest batch → ordinal 1 (matches UI "Batch 1"). */
export function buildOrdinalMap(summaries: BatchSummary[]): Map<string, number> {
  const sorted = [...summaries].sort((a, b) => {
    const ta = firstRunTimeMs(a);
    const tb = firstRunTimeMs(b);
    if (ta !== tb) return ta - tb;
    return a.batch_id.localeCompare(b.batch_id);
  });
  const map = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s) map.set(s.batch_id, i + 1);
  }
  return map;
}

function lastActivityTimeMs(s: BatchSummary): number {
  const raw = s.last_activity_at ?? s.first_run_at;
  if (!raw) return 0;
  return new Date(raw).getTime();
}

/**
 * Partition runs and merge API batch summaries with synthetic rows for any batch_id
 * present in loaded runs but missing from `batchSummaries` (truncation / race).
 */
export function buildRunHistoryBatchView(
  runs: DbFlowRun[],
  batchSummaries: BatchSummary[] | undefined,
): RunHistoryBatchView {
  const batchedRunsMap = new Map<string, DbFlowRun[]>();
  const unbatched: DbFlowRun[] = [];

  for (const run of runs) {
    if (run.batch_id) {
      const list = batchedRunsMap.get(run.batch_id) ?? [];
      list.push(run);
      batchedRunsMap.set(run.batch_id, list);
    } else {
      unbatched.push(run);
    }
  }

  const summaryList = batchSummaries ?? [];
  const apiById = new Map(summaryList.map((s) => [s.batch_id, s]));

  const merged: BatchSummary[] = [];
  for (const batchId of batchedRunsMap.keys()) {
    const batchRuns = batchedRunsMap.get(batchId);
    if (!batchRuns || batchRuns.length === 0) continue;
    const fromApi = apiById.get(batchId);
    merged.push(fromApi ?? syntheticBatchSummaryFromRuns(batchId, batchRuns));
  }

  merged.sort((a, b) => {
    const tb = lastActivityTimeMs(b);
    const ta = lastActivityTimeMs(a);
    if (tb !== ta) return tb - ta;
    return b.batch_id.localeCompare(a.batch_id);
  });

  const active = merged.filter((s) => s.active_count > 0);
  const rest = merged.filter((s) => s.active_count === 0);
  const batched = [...active, ...rest];
  const ordinalMap = buildOrdinalMap(merged);

  return { batched, unbatched, batchedRunsMap, ordinalMap };
}
