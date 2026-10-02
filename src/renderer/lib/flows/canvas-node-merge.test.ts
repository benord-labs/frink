import { describe, expect, it } from 'vitest';
import { type CanvasNodeRun, mergeNodeRunsForCanvas } from './canvas-node-merge';

function nodeRun(id: string, status: string, attempt = 1): CanvasNodeRun {
  return {
    id,
    flow_run_id: 'fr',
    node_id: 'approve',
    block_type: 'approval',
    status,
    node_output: null,
    attempt_number: attempt,
    lane_index: null,
    parent_fan_out_node_run_id: null,
  };
}

const merged = (rows: CanvasNodeRun[]) => mergeNodeRunsForCanvas(rows, null).get('approve');

describe('mergeNodeRunsForCanvas — a retried node reads as its latest attempt', () => {
  it.each([
    ['completed', 'completed'],
    ['running', 'running'],
    ['failed', 'failed'],
  ])('superseded + %s retry → %s', (retryStatus, expected) => {
    expect(merged([nodeRun('old', 'superseded'), nodeRun('new', retryStatus, 2)])?.status).toBe(
      expected,
    );
  });

  it('keeps a still-parked node parked when no retry replaced it', () => {
    expect(merged([nodeRun('only', 'awaiting_input')])?.status).toBe('awaiting_input');
  });
});
