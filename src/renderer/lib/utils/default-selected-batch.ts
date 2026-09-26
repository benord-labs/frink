/**
 * Default batch selection for the FlowEditor Runs tab: the flow's active batch (the
 * persisted run target) when set, else the most recently active batch from `listBatches`.
 * The active batch may legitimately be absent from the summaries (a planned batch whose
 * runs were never dispatched has stages but no flow_runs) — it still wins.
 */

type BatchSummaryLike = {
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchSummary (tRPC/DB) shape
  batch_id: string;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchSummary (tRPC/DB) shape
  first_run_at: string | null;
  // biome-ignore lint/style/useNamingConvention: mirrors the snake_case BatchSummary (tRPC/DB) shape
  last_activity_at: string | null;
};

export function resolveDefaultSelectedBatchId(
  activeBatchId: string | null,
  batches: BatchSummaryLike[] | undefined,
): string | null {
  if (activeBatchId) return activeBatchId;
  if (!batches || batches.length === 0) return null;
  const activityTime = (b: BatchSummaryLike): number => {
    const ts = b.last_activity_at ?? b.first_run_at;
    return ts ? new Date(ts).getTime() : 0;
  };
  return batches.reduce((newest, b) => (activityTime(b) > activityTime(newest) ? b : newest))
    .batch_id;
}
