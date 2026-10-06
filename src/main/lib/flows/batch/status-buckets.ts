/**
 * Buckets per-status run counts the way a batch summary reports them: cancelled runs count as
 * failed, and running / paused / pending runs are all still active.
 */

export type BatchStatusBuckets = {
  completed: number;
  failed: number;
  active: number;
  /** Every run counted, whatever its status, so a status outside the buckets shows as a gap. */
  total: number;
};

export function bucketBatchStatusCounts(counts: Record<string, number>): BatchStatusBuckets {
  const of = (status: string) => counts[status] ?? 0;
  return {
    completed: of('completed'),
    failed: of('failed') + of('cancelled'),
    active: of('running') + of('paused') + of('pending'),
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}
