import { describe, expect, it } from 'vitest';
import { countUniqueLanesByParent } from './count-unique-lanes-by-parent';

describe('countUniqueLanesByParent', () => {
  it('counts unique lane_index per parent, not total rows (3 lanes × 2 body nodes = 3)', () => {
    const parent = 'fan-out-parent-run-id';
    const rows = [
      { parent_fan_out_node_run_id: parent, lane_index: 0 },
      { parent_fan_out_node_run_id: parent, lane_index: 0 },
      { parent_fan_out_node_run_id: parent, lane_index: 1 },
      { parent_fan_out_node_run_id: parent, lane_index: 1 },
      { parent_fan_out_node_run_id: parent, lane_index: 2 },
      { parent_fan_out_node_run_id: parent, lane_index: 2 },
    ];
    expect(countUniqueLanesByParent(rows).get(parent)).toBe(3);
  });

  it('returns 1 for a single lane with multiple body-node rows', () => {
    const parent = 'p1';
    const rows = [
      { parent_fan_out_node_run_id: parent, lane_index: 0 },
      { parent_fan_out_node_run_id: parent, lane_index: 0 },
    ];
    expect(countUniqueLanesByParent(rows).get(parent)).toBe(1);
  });

  it('ignores rows without parent or lane_index', () => {
    const rows = [
      { parent_fan_out_node_run_id: null, lane_index: 0 },
      { parent_fan_out_node_run_id: 'x', lane_index: null },
      { parent_fan_out_node_run_id: 'x', lane_index: 1 },
    ];
    expect(countUniqueLanesByParent(rows).get('x')).toBe(1);
  });

  it('separates counts by parent id', () => {
    const rows = [
      { parent_fan_out_node_run_id: 'a', lane_index: 0 },
      { parent_fan_out_node_run_id: 'a', lane_index: 1 },
      { parent_fan_out_node_run_id: 'b', lane_index: 0 },
    ];
    const m = countUniqueLanesByParent(rows);
    expect(m.get('a')).toBe(2);
    expect(m.get('b')).toBe(1);
  });
});
