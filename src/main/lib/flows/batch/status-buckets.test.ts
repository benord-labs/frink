import { describe, expect, it } from 'vitest';
import { bucketBatchStatusCounts } from './status-buckets';

describe('bucketBatchStatusCounts', () => {
  it('counts cancelled as failed and running, paused and pending as active', () => {
    expect(
      bucketBatchStatusCounts({
        completed: 40,
        failed: 3,
        cancelled: 2,
        running: 8,
        paused: 4,
        pending: 3,
      }),
    ).toEqual({ completed: 40, failed: 5, active: 15, total: 60 });
  });

  it('is all zeros for a batch with no runs', () => {
    expect(bucketBatchStatusCounts({})).toEqual({
      completed: 0,
      failed: 0,
      active: 0,
      total: 0,
    });
  });

  it('counts a status outside the buckets in the total only', () => {
    expect(bucketBatchStatusCounts({ completed: 1, archived: 2 })).toEqual({
      completed: 1,
      failed: 0,
      active: 0,
      total: 3,
    });
  });
});
