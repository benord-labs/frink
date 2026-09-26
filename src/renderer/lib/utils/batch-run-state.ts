/**
 * Derives the Flow editor "Run batch" button state from the batch's stage detail (the already-
 * fetched trpc.flows.listBatchStages output). The primary (one-click) action adapts to where the
 * batch is: never-run → start it; running → disable it; already run → disable it, since recovery
 * is per-member (Retry / Carry on in each run's chat), not a whole-batch action. No new query.
 */

type BatchPrimaryAction = 'start' | 'running' | 'unavailable';

/**
 * Only the fields deriveBatchRunState reads — structurally a subset of BatchStageDetail. Field
 * names mirror that snake_case tRPC/DB shape verbatim, so callers pass listBatchStages rows as-is.
 */
export type StageRunCounts = {
  status: string;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchStageDetail (tRPC/DB) shape
  run_count: number;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchStageDetail (tRPC/DB) shape
  completed_count: number;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchStageDetail (tRPC/DB) shape
  failed_count: number;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchStageDetail (tRPC/DB) shape
  active_count: number;
};

export type BatchRunState = {
  /** The button's one-click action. `running` = a run is in flight (button disabled). */
  primary: BatchPrimaryAction;
  counts: { total: number; failed: number; completed: number; active: number };
};

export function deriveBatchRunState(stages: StageRunCounts[]): BatchRunState {
  const counts = stages.reduce(
    (acc, s) => ({
      total: acc.total + s.run_count,
      failed: acc.failed + s.failed_count,
      completed: acc.completed + s.completed_count,
      active: acc.active + s.active_count,
    }),
    { total: 0, failed: 0, completed: 0, active: 0 },
  );

  const anyRunning = stages.some((s) => s.status === 'running');
  // "Has run" = at least one stage left the initial pending state (something was dispatched/settled).
  const hasRun = stages.some((s) => s.status !== 'pending') || counts.completed + counts.failed > 0;

  if (anyRunning) return { primary: 'running', counts };
  if (!hasRun) return { primary: 'start', counts };

  return { primary: 'unavailable', counts };
}
