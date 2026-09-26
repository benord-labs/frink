import { describe, expect, it } from 'vitest';
import { isFlowRunDetailAlignedWithLatestRun } from './flow-canvas-rehydrate-eligibility';

describe('isFlowRunDetailAlignedWithLatestRun', () => {
  const detail = { id: 'run-a', status: 'running' as const };

  it('returns true when latest run is the same id and still running', () => {
    expect(isFlowRunDetailAlignedWithLatestRun(detail, { id: 'run-a', status: 'running' })).toBe(
      true,
    );
  });

  it('returns false when listRuns no longer shows running (stale cached getRun)', () => {
    expect(isFlowRunDetailAlignedWithLatestRun(detail, { id: 'run-a', status: 'completed' })).toBe(
      false,
    );
  });

  it('returns false when a newer run is latest (id mismatch)', () => {
    expect(isFlowRunDetailAlignedWithLatestRun(detail, { id: 'run-b', status: 'running' })).toBe(
      false,
    );
  });

  it('returns false when latestRun is undefined', () => {
    expect(isFlowRunDetailAlignedWithLatestRun(detail, undefined)).toBe(false);
  });

  it('returns false when detail is not running', () => {
    expect(
      isFlowRunDetailAlignedWithLatestRun(
        { id: 'run-a', status: 'completed' },
        {
          id: 'run-a',
          status: 'running',
        },
      ),
    ).toBe(false);
  });
});
