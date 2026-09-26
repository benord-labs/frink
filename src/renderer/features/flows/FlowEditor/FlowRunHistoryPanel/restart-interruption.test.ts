import { describe, expect, it } from 'vitest';
import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { findRestartInterruptedNodeRun } from './restart-interruption';

function nodeRun(partial: Partial<DbNodeRun>): DbNodeRun {
  return {
    id: 'nr',
    flow_run_id: 'fr',
    node_id: 'n',
    block_type: 'agent',
    status: 'completed',
    node_output: null,
    attempt_number: 1,
    started_at: null,
    completed_at: null,
    created_at: '2026-06-04T00:00:00.000Z',
    lane_index: null,
    parent_fan_out_node_run_id: null,
    ...partial,
  };
}

const restartMarker = { error: { message: RESTART_INTERRUPTION_REASON, retryable: true } };

describe('findRestartInterruptedNodeRun', () => {
  it('returns the last non-completed node when it carries the restart marker', () => {
    const interrupted = nodeRun({
      id: 'b',
      node_id: 'agent-1',
      status: 'cancelled',
      node_output: restartMarker,
    });
    const result = findRestartInterruptedNodeRun([
      nodeRun({ id: 'a', node_id: 'start', status: 'completed' }),
      interrupted,
    ]);
    expect(result?.id).toBe('b');
  });

  it('returns null for a user-initiated cancel (no marker)', () => {
    const result = findRestartInterruptedNodeRun([
      nodeRun({ id: 'a', status: 'completed' }),
      nodeRun({
        id: 'b',
        status: 'cancelled',
        node_output: { error: { message: 'Cancelled', retryable: false } },
      }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null when every node finished cleanly', () => {
    const result = findRestartInterruptedNodeRun([
      nodeRun({ id: 'a', status: 'completed' }),
      nodeRun({ id: 'b', status: 'skipped' }),
    ]);
    expect(result).toBeNull();
  });

  it('ignores trailing completed/skipped nodes and inspects the real interrupted node', () => {
    const result = findRestartInterruptedNodeRun([
      nodeRun({ id: 'a', status: 'cancelled', node_output: restartMarker }),
      nodeRun({ id: 'b', status: 'skipped' }),
    ]);
    // 'b' is skipped → skipped; 'a' is the interrupted node and carries the marker.
    expect(result?.id).toBe('a');
  });
});
