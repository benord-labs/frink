/**
 * Batch monitor DAG graph — topology memo contract (feature-completeness regression guard).
 * Status/progress must not change computeMonitorTopologyKey; BatchDagCanvas layer 3 merges live stages.
 */

import { describe, expect, it } from 'vitest';
import type { BatchStageDetail } from '../../../../../../shared/types/flows/flow-batch';
import { buildBatchMonitorGraph, computeMonitorTopologyKey } from './build-batch-dag-graph';
import { MONITOR_NODE_HEIGHT, MONITOR_NODE_WIDTH } from './constants';

function makeStage(
  overrides: Partial<BatchStageDetail> & Pick<BatchStageDetail, 'id'>,
): BatchStageDetail {
  return {
    stage_number: 1,
    name: null,
    status: 'pending',
    failure_threshold: 0,
    depends_on_stage_ids: [],
    depends_on_stage_numbers: [],
    run_count: 0,
    completed_count: 0,
    failed_count: 0,
    active_count: 0,
    latest_chat_id: null,
    workstream_ids: [],
    ...overrides,
  };
}

describe('computeMonitorTopologyKey', () => {
  it('is unchanged when only status and run counts change (same ids and deps)', () => {
    const a = [
      makeStage({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'running',
        run_count: 5,
        completed_count: 1,
      }),
    ];
    const b = [
      makeStage({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'completed',
        run_count: 5,
        completed_count: 5,
      }),
    ];
    expect(computeMonitorTopologyKey(a)).toBe(computeMonitorTopologyKey(b));
  });

  it('changes when depends_on_stage_ids changes', () => {
    const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const leaf = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const linear = [
      makeStage({ id: root, stage_number: 1 }),
      makeStage({ id: leaf, stage_number: 2, depends_on_stage_ids: [root] }),
    ];
    const parallel = [
      makeStage({ id: root, stage_number: 1 }),
      makeStage({ id: leaf, stage_number: 2, depends_on_stage_ids: [] }),
    ];
    expect(computeMonitorTopologyKey(linear)).not.toBe(computeMonitorTopologyKey(parallel));
  });
});

describe('buildBatchMonitorGraph', () => {
  it('embeds current stage snapshot in node data (callers must merge fresh stages when memoizing layout on topology only)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const v1 = [makeStage({ id, status: 'running', completed_count: 0, run_count: 3 })];
    const v2 = [makeStage({ id, status: 'completed', completed_count: 3, run_count: 3 })];
    expect(computeMonitorTopologyKey(v1)).toBe(computeMonitorTopologyKey(v2));
    const g1 = buildBatchMonitorGraph(v1, null, () => {});
    const g2 = buildBatchMonitorGraph(v2, null, () => {});
    expect(g1.nodes[0]?.data.stage.status).toBe('running');
    expect(g2.nodes[0]?.data.stage.status).toBe('completed');
  });

  it('sets explicit width/height on each node so MiniMap and fitView receive a valid bbox', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const g = buildBatchMonitorGraph([makeStage({ id })], null, () => {});
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]?.width).toBe(MONITOR_NODE_WIDTH);
    expect(g.nodes[0]?.height).toBe(MONITOR_NODE_HEIGHT);
  });
});
