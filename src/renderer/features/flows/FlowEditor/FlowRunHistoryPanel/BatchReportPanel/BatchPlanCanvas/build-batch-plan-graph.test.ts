/**
 * Unit tests for buildBatchPlanGraph.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BatchStageDetail } from '../../../../../../../shared/types/flows/flow-batch';
import { buildBatchPlanGraph } from './build-batch-plan-graph';

vi.mock('@dagrejs/dagre', () => {
  const mockGraphInstance = {
    setDefaultEdgeLabel: vi.fn().mockReturnThis(),
    setGraph: vi.fn().mockReturnThis(),
    setNode: vi.fn().mockReturnThis(),
    setEdge: vi.fn().mockReturnThis(),
    node: vi.fn().mockReturnValue({ x: 70, y: 26 }),
  };
  function MockGraph() {
    return mockGraphInstance;
  }
  MockGraph.prototype = mockGraphInstance;
  return {
    default: {
      graphlib: { Graph: MockGraph },
      layout: vi.fn(),
    },
  };
});

function makeStage(overrides: Partial<BatchStageDetail> & { id: string }): BatchStageDetail {
  return {
    id: overrides.id,
    stage_number: overrides.stage_number ?? 1,
    name: overrides.name ?? null,
    status: overrides.status ?? 'pending',
    failure_threshold: overrides.failure_threshold ?? 0,
    depends_on_stage_ids: overrides.depends_on_stage_ids ?? [],
    depends_on_stage_numbers: overrides.depends_on_stage_numbers ?? [],
    run_count: overrides.run_count ?? 1,
    completed_count: overrides.completed_count ?? 0,
    failed_count: overrides.failed_count ?? 0,
    active_count: overrides.active_count ?? 0,
    attention_count: overrides.attention_count ?? 0,
    pending_count: overrides.pending_count ?? 0,
    latest_chat_id: overrides.latest_chat_id ?? null,
    workstream_ids: overrides.workstream_ids ?? [],
  };
}

const noop = () => {};

describe('buildBatchPlanGraph', () => {
  it('empty stages → empty graph', () => {
    const result = buildBatchPlanGraph([], null, noop);
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.topologyKey).toBe('');
  });

  it('single stage with no deps → 1 node, 0 edges', () => {
    const stages = [makeStage({ id: 'a', stage_number: 1 })];
    const result = buildBatchPlanGraph(stages, null, noop);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('linear chain A→B→C → 3 nodes, 2 edges', () => {
    const stages = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'] }),
      makeStage({ id: 'c', stage_number: 3, depends_on_stage_ids: ['b'] }),
    ];
    const result = buildBatchPlanGraph(stages, null, noop);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['a->b', 'b->c']);
  });

  it('diamond DAG A→{B,C}→D → 4 nodes, 4 edges', () => {
    const stages = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'] }),
      makeStage({ id: 'c', stage_number: 3, depends_on_stage_ids: ['a'] }),
      makeStage({ id: 'd', stage_number: 4, depends_on_stage_ids: ['b', 'c'] }),
    ];
    const result = buildBatchPlanGraph(stages, null, noop);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(4);
    const edgeIds = result.edges.map((e) => `${e.source}->${e.target}`);
    expect(edgeIds).toContain('a->b');
    expect(edgeIds).toContain('a->c');
    expect(edgeIds).toContain('b->d');
    expect(edgeIds).toContain('c->d');
  });

  it('dangling dep ID → edge filtered out silently', () => {
    const stages = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a', 'nonexistent-uuid'] }),
    ];
    const result = buildBatchPlanGraph(stages, null, noop);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.source).toBe('a');
    expect(result.edges[0]?.target).toBe('b');
  });

  it('null stage name → node data carries original null (display handled in component)', () => {
    const stages = [makeStage({ id: 'a', stage_number: 1, name: null })];
    const result = buildBatchPlanGraph(stages, null, noop);
    expect(result.nodes[0]?.data.stage.name).toBeNull();
  });

  it('edge style.stroke reflects source stage status (inline stroke, not className)', () => {
    const stages = [
      makeStage({ id: 'a', stage_number: 1, status: 'completed' }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'], status: 'running' }),
    ];
    const result = buildBatchPlanGraph(stages, null, noop);
    const edge = result.edges.find((e) => e.source === 'a' && e.target === 'b');
    expect(edge?.style?.stroke).toBe('hsl(var(--status-online) / 0.6)');
    // className should not be set (it does not reach the <path> element in React Flow)
    expect(edge?.className).toBeUndefined();
  });

  it('selectedStageId marks correct node as selected', () => {
    const stages = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2 }),
    ];
    const result = buildBatchPlanGraph(stages, 'b', noop);
    const nodeA = result.nodes.find((n) => n.id === 'a');
    const nodeB = result.nodes.find((n) => n.id === 'b');
    expect(nodeA?.data.isSelected).toBe(false);
    expect(nodeB?.data.isSelected).toBe(true);
  });

  it('topology key is stable across status-only changes', () => {
    const base = [
      makeStage({ id: 'a', stage_number: 1, status: 'pending' }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'], status: 'pending' }),
    ];
    const updated = [
      makeStage({ id: 'a', stage_number: 1, status: 'completed' }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'], status: 'running' }),
    ];
    expect(buildBatchPlanGraph(base, null, noop).topologyKey).toBe(
      buildBatchPlanGraph(updated, null, noop).topologyKey,
    );
  });

  it('topology key changes when dependency structure changes', () => {
    const before = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: [] }),
    ];
    const after = [
      makeStage({ id: 'a', stage_number: 1 }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'] }),
    ];
    expect(buildBatchPlanGraph(before, null, noop).topologyKey).not.toBe(
      buildBatchPlanGraph(after, null, noop).topologyKey,
    );
  });

  it('topology key is stable across workstream_ids changes (workstream is visual-only)', () => {
    const base = [
      makeStage({ id: 'a', stage_number: 1, workstream_ids: [] }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'], workstream_ids: [] }),
    ];
    const withWorkstreams = [
      makeStage({ id: 'a', stage_number: 1, workstream_ids: ['auth'] }),
      makeStage({ id: 'b', stage_number: 2, depends_on_stage_ids: ['a'], workstream_ids: ['api'] }),
    ];
    expect(buildBatchPlanGraph(base, null, noop).topologyKey).toBe(
      buildBatchPlanGraph(withWorkstreams, null, noop).topologyKey,
    );
  });
});
