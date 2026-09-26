import { describe, expect, it } from 'vitest';
import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import { getNodeRunTooltipText } from './node-run-tooltip';

function baseRun(overrides: Partial<DbNodeRun>): DbNodeRun {
  return {
    id: 'n1',
    flow_run_id: 'r1',
    node_id: 'node-1',
    block_type: 'run_command',
    status: 'completed',
    node_output: null,
    attempt_number: 1,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    lane_index: null,
    parent_fan_out_node_run_id: null,
    ...overrides,
  };
}

describe('getNodeRunTooltipText', () => {
  it('returns Pending for pending status', () => {
    expect(getNodeRunTooltipText(baseRun({ status: 'pending' }))).toBe('Pending');
  });

  it('returns Awaiting input', () => {
    expect(getNodeRunTooltipText(baseRun({ status: 'awaiting_input' }))).toBe('Awaiting input');
  });

  it('returns Completed with wall duration when timestamps present', () => {
    const t = getNodeRunTooltipText(
      baseRun({
        status: 'completed',
        started_at: '2025-01-01T00:00:00.000Z',
        completed_at: '2025-01-01T00:00:02.500Z',
      }),
    );
    expect(t).toBe('Completed in 2.5s');
  });

  it('returns Running… when no started_at', () => {
    expect(getNodeRunTooltipText(baseRun({ status: 'running' }))).toBe('Running…');
  });

  it('returns Running for live elapsed when started_at and nowMs are provided', () => {
    const t = getNodeRunTooltipText(
      baseRun({
        status: 'running',
        started_at: '2025-01-01T00:00:00.000Z',
      }),
      new Date('2025-01-01T00:00:33.000Z').getTime(),
    );
    expect(t).toBe('Running for 33s');
  });

  it('uses live ms format for sub-second running elapsed (matches expanded detail)', () => {
    const start = new Date('2025-01-01T00:00:00.000Z').getTime();
    const t = getNodeRunTooltipText(
      baseRun({
        status: 'running',
        started_at: '2025-01-01T00:00:00.000Z',
      }),
      start + 500,
    );
    expect(t).toBe('Running for 500ms');
  });

  it('clamps negative elapsed when nowMs is before started_at', () => {
    const t = getNodeRunTooltipText(
      baseRun({
        status: 'running',
        started_at: '2025-01-01T00:00:10.000Z',
      }),
      new Date('2025-01-01T00:00:00.000Z').getTime(),
    );
    expect(t).toBe('Running for 0ms');
  });

  it('returns Failed with exit code when no error message', () => {
    const t = getNodeRunTooltipText(
      baseRun({
        status: 'failed',
        node_output: {
          status: 'failed',
          outputs: { exitCode: 128 },
          durationMs: 0,
          error: { message: '', retryable: true },
        },
      }),
    );
    expect(t).toContain('Exit code: 128');
  });
});
