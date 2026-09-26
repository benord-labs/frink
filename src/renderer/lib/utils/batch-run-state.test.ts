import { describe, expect, it } from 'vitest';
import { deriveBatchRunState, type StageRunCounts } from './batch-run-state';

function stage(s: Partial<StageRunCounts> & { status: string }): StageRunCounts {
  return { run_count: 0, completed_count: 0, failed_count: 0, active_count: 0, ...s };
}

describe('deriveBatchRunState', () => {
  it('treats no stages as a never-run batch, leaving emptiness for the caller to read', () => {
    expect(deriveBatchRunState([])).toEqual({
      primary: 'start',
      counts: { total: 0, failed: 0, completed: 0, active: 0 },
    });
  });

  it('never-run batch → primary "start", no modes', () => {
    const r = deriveBatchRunState([stage({ status: 'pending', run_count: 3, active_count: 3 })]);
    expect(r.primary).toBe('start');
  });

  it('a running stage → primary "running" (disabled), no modes', () => {
    const r = deriveBatchRunState([
      stage({ status: 'running', run_count: 2, active_count: 1, completed_count: 1 }),
    ]);
    expect(r.primary).toBe('running');
  });

  it('terminal with failures → recovery unavailable', () => {
    const r = deriveBatchRunState([
      stage({ status: 'failed', run_count: 3, completed_count: 1, failed_count: 2 }),
    ]);
    expect(r.primary).toBe('unavailable');
    expect(r.counts).toMatchObject({ total: 3, failed: 2, completed: 1 });
  });

  it('terminal all-completed → recovery unavailable', () => {
    const r = deriveBatchRunState([
      stage({ status: 'completed', run_count: 2, completed_count: 2 }),
    ]);
    expect(r.primary).toBe('unavailable');
  });

  it('all runs failed → recovery unavailable', () => {
    const r = deriveBatchRunState([stage({ status: 'failed', run_count: 2, failed_count: 2 })]);
    expect(r.primary).toBe('unavailable');
  });

  it('all cancelled → recovery unavailable', () => {
    const r = deriveBatchRunState([stage({ status: 'cancelled', run_count: 2 })]);
    expect(r.primary).toBe('unavailable');
  });

  it('aggregates counts across a multi-stage DAG', () => {
    const r = deriveBatchRunState([
      stage({ status: 'completed', run_count: 2, completed_count: 2 }),
      stage({ status: 'failed', run_count: 3, completed_count: 1, failed_count: 2 }),
    ]);
    expect(r.counts).toEqual({ total: 5, failed: 2, completed: 3, active: 0 });
    expect(r.primary).toBe('unavailable');
  });
});
