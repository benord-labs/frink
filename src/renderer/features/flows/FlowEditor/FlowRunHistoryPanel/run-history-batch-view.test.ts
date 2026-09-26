import { describe, expect, it } from 'vitest';
import type { BatchSummary } from '../../../../../shared/types/flows/flow-batch';
import type { DbFlowRun } from '../../../../../shared/types/flow-run';
import {
  buildOrdinalMap,
  buildRunHistoryBatchView,
  syntheticBatchSummaryFromRuns,
} from './run-history-batch-view';

const BATCH_OLD = '10000000-0000-4000-8000-000000000001';
const BATCH_NEW = '20000000-0000-4000-8000-000000000002';
const BATCH_MISSING = '30000000-0000-4000-8000-000000000003';

function run(partial: Partial<DbFlowRun> & Pick<DbFlowRun, 'id' | 'status'>): DbFlowRun {
  return {
    flow_version_id: 'fv-1',
    trigger_context: null,
    idempotency_key: null,
    started_at: '2025-06-01T12:00:00.000Z',
    completed_at: null,
    created_at: '2025-06-01T12:00:00.000Z',
    ...partial,
  };
}

describe('syntheticBatchSummaryFromRuns', () => {
  it('derives counts and timestamps from loaded runs', () => {
    const runs = [
      run({
        id: 'r1',
        status: 'completed',
        batch_id: BATCH_MISSING,
        started_at: '2025-06-01T10:00:00.000Z',
        completed_at: '2025-06-01T10:05:00.000Z',
      }),
      run({
        id: 'r2',
        status: 'running',
        batch_id: BATCH_MISSING,
        started_at: '2025-06-01T11:00:00.000Z',
        completed_at: null,
      }),
    ];
    const s = syntheticBatchSummaryFromRuns(BATCH_MISSING, runs);
    expect(s.batch_id).toBe(BATCH_MISSING);
    expect(s.run_count).toBe(2);
    expect(s.completed_count).toBe(1);
    expect(s.failed_count).toBe(0);
    expect(s.running_count).toBe(1);
    expect(s.active_count).toBe(1);
    expect(s.errored_count).toBe(0);
    expect(s.first_run_at).toBe('2025-06-01T10:00:00.000Z');
    expect(s.last_activity_at).toBeTruthy();
  });
});

describe('buildRunHistoryBatchView', () => {
  it('uses API summaries when every batch_id is returned', () => {
    const summaries: BatchSummary[] = [
      {
        batch_id: BATCH_NEW,
        run_count: 10,
        completed_count: 5,
        failed_count: 0,
        errored_count: 0,
        running_count: 0,
        active_count: 0,
        first_run_at: '2025-06-02T00:00:00.000Z',
        last_activity_at: '2025-06-02T12:00:00.000Z',
      },
    ];
    const runs = [run({ id: 'a', status: 'completed', batch_id: BATCH_NEW })];
    const v = buildRunHistoryBatchView(runs, summaries);
    expect(v.unbatched).toHaveLength(0);
    expect(v.batched).toHaveLength(1);
    expect(v.batched[0]?.run_count).toBe(10);
    expect(v.batchedRunsMap.get(BATCH_NEW)).toHaveLength(1);
  });

  it('synthesizes a summary when runs have batch_id but API omitted that batch (e.g. limit)', () => {
    const summaries: BatchSummary[] = [
      {
        batch_id: BATCH_NEW,
        run_count: 2,
        completed_count: 2,
        failed_count: 0,
        errored_count: 0,
        running_count: 0,
        active_count: 0,
        first_run_at: '2025-06-02T00:00:00.000Z',
        last_activity_at: '2025-06-02T12:00:00.000Z',
      },
    ];
    const runs = [
      run({ id: 'x', status: 'completed', batch_id: BATCH_NEW }),
      run({
        id: 'y',
        status: 'failed',
        batch_id: BATCH_MISSING,
        started_at: '2025-06-01T08:00:00.000Z',
        completed_at: '2025-06-01T08:01:00.000Z',
      }),
    ];
    const v = buildRunHistoryBatchView(runs, summaries);
    expect(v.batchedRunsMap.has(BATCH_MISSING)).toBe(true);
    const missingSummary = v.batched.find((s) => s.batch_id === BATCH_MISSING);
    expect(missingSummary).toBeDefined();
    expect(missingSummary?.run_count).toBe(1);
    expect(missingSummary?.errored_count).toBe(1);
    expect(v.batched.some((s) => s.batch_id === BATCH_NEW)).toBe(true);
    expect(v.batched.some((s) => s.batch_id === BATCH_MISSING)).toBe(true);
  });

  it('places unbatched runs aside and does not drop them', () => {
    const runs = [
      run({ id: 'u1', status: 'completed', batch_id: null }),
      run({ id: 'b1', status: 'completed', batch_id: BATCH_NEW }),
    ];
    const summaries: BatchSummary[] = [
      {
        batch_id: BATCH_NEW,
        run_count: 1,
        completed_count: 1,
        failed_count: 0,
        errored_count: 0,
        running_count: 0,
        active_count: 0,
        first_run_at: '2025-06-02T00:00:00.000Z',
        last_activity_at: '2025-06-02T12:00:00.000Z',
      },
    ];
    const v = buildRunHistoryBatchView(runs, summaries);
    expect(v.unbatched.map((r) => r.id)).toEqual(['u1']);
    expect(v.batchedRunsMap.get(BATCH_NEW)?.map((r) => r.id)).toEqual(['b1']);
  });

  it('assigns Batch 1 to the oldest first_run_at among merged summaries', () => {
    const oldSummary: BatchSummary = {
      batch_id: BATCH_OLD,
      run_count: 1,
      completed_count: 1,
      failed_count: 0,
      errored_count: 0,
      running_count: 0,
      active_count: 0,
      first_run_at: '2025-01-01T00:00:00.000Z',
      last_activity_at: '2025-01-01T01:00:00.000Z',
    };
    const newSummary: BatchSummary = {
      batch_id: BATCH_NEW,
      run_count: 1,
      completed_count: 1,
      failed_count: 0,
      errored_count: 0,
      running_count: 0,
      active_count: 0,
      first_run_at: '2025-12-01T00:00:00.000Z',
      last_activity_at: '2025-12-01T01:00:00.000Z',
    };
    const runs = [
      run({ id: 'o', status: 'completed', batch_id: BATCH_OLD }),
      run({ id: 'n', status: 'completed', batch_id: BATCH_NEW }),
    ];
    const v = buildRunHistoryBatchView(runs, [newSummary, oldSummary]);
    expect(v.ordinalMap.get(BATCH_OLD)).toBe(1);
    expect(v.ordinalMap.get(BATCH_NEW)).toBe(2);
  });
});

describe('buildOrdinalMap', () => {
  it('ties break on batch_id for stable ordering', () => {
    const a: BatchSummary = {
      batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      run_count: 1,
      completed_count: 1,
      failed_count: 0,
      errored_count: 0,
      running_count: 0,
      active_count: 0,
      first_run_at: '2025-06-01T00:00:00.000Z',
      last_activity_at: '2025-06-01T01:00:00.000Z',
    };
    const b: BatchSummary = {
      batch_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      run_count: 1,
      completed_count: 1,
      failed_count: 0,
      errored_count: 0,
      running_count: 0,
      active_count: 0,
      first_run_at: '2025-06-01T00:00:00.000Z',
      last_activity_at: '2025-06-01T01:00:00.000Z',
    };
    const m = buildOrdinalMap([b, a]);
    expect(m.get(a.batch_id)).toBe(1);
    expect(m.get(b.batch_id)).toBe(2);
  });
});
