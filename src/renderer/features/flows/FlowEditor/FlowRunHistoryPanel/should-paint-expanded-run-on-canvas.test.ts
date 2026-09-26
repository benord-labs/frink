import { describe, expect, it } from 'vitest';
import type { DbFlowRunWithNodeRuns } from '../../../../../shared/types/flow-run';
import { shouldPaintExpandedRunOnCanvas } from './should-paint-expanded-run-on-canvas';

function minimalRun(
  overrides: Partial<DbFlowRunWithNodeRuns> & Pick<DbFlowRunWithNodeRuns, 'id' | 'status'>,
): DbFlowRunWithNodeRuns {
  return {
    flow_version_id: 'fv',
    trigger_context: null,
    idempotency_key: null,
    started_at: null,
    completed_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    graph: null,
    nodeRuns: [],
    ...overrides,
  };
}

describe('shouldPaintExpandedRunOnCanvas', () => {
  it('returns false when expandedRunId is null', () => {
    expect(shouldPaintExpandedRunOnCanvas(null, minimalRun({ id: 'a', status: 'completed' }))).toBe(
      false,
    );
  });

  it('returns false when run is undefined', () => {
    expect(shouldPaintExpandedRunOnCanvas('a', undefined)).toBe(false);
  });

  it('returns false when run.id does not match expandedRunId (stale cache)', () => {
    expect(shouldPaintExpandedRunOnCanvas('b', minimalRun({ id: 'a', status: 'completed' }))).toBe(
      false,
    );
  });

  it('returns false for running and paused runs', () => {
    expect(shouldPaintExpandedRunOnCanvas('r', minimalRun({ id: 'r', status: 'running' }))).toBe(
      false,
    );
    expect(shouldPaintExpandedRunOnCanvas('p', minimalRun({ id: 'p', status: 'paused' }))).toBe(
      false,
    );
  });

  it('returns true for terminal runs that match expandedRunId', () => {
    const failed = minimalRun({ id: 'f', status: 'failed' });
    expect(shouldPaintExpandedRunOnCanvas('f', failed)).toBe(true);

    const completed = minimalRun({ id: 'c', status: 'completed' });
    expect(shouldPaintExpandedRunOnCanvas('c', completed)).toBe(true);

    const cancelled = minimalRun({ id: 'x', status: 'cancelled' });
    expect(shouldPaintExpandedRunOnCanvas('x', cancelled)).toBe(true);
  });
});
