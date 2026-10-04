import { describe, expect, it } from 'vitest';
import type { DbFlowRunWithNodeRuns } from '../../../../shared/types/flow-run';
import { isFanOutSummary, MAX_SUMMARY_NODES, mapFlowRunToSummary } from './map-flow-run';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<DbFlowRunWithNodeRuns> = {}): DbFlowRunWithNodeRuns {
  return {
    id: 'run-1',
    flow_version_id: 'version-1',
    status: 'completed',
    trigger_context: null,
    idempotency_key: null,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:12.345Z',
    created_at: '2026-01-01T00:00:00.000Z',
    nodeRuns: [],
    graph: null,
    ...overrides,
  };
}

function makeNodeRun(
  id: string,
  overrides: Record<string, unknown> = {},
): DbFlowRunWithNodeRuns['nodeRuns'][number] {
  return {
    id,
    flow_run_id: 'run-1',
    node_id: 'n1',
    block_type: 'run_command',
    status: 'completed',
    node_output: null,
    attempt_number: 1,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    lane_index: null,
    parent_fan_out_node_run_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EC1: Fan-out aggregation
// ---------------------------------------------------------------------------

describe('EC1: fan-out aggregation', () => {
  it('aggregates 100 lanes × 3 body nodes into a single fan-out summary entry', () => {
    const fanOutRunId = 'fo-run-1';
    const fanOutNodeId = 'fan-out-node';

    const children = Array.from({ length: 100 }, (_, lane) =>
      Array.from({ length: 3 }, (__, bodyIdx) => ({
        ...makeNodeRun(`child-${lane}-${bodyIdx}`),
        node_id: `body-${bodyIdx}`,
        block_type: 'run_command',
        parent_fan_out_node_run_id: fanOutRunId,
        lane_index: lane,
        // Lanes 98 and 99 fail
        status: lane < 98 ? 'completed' : 'failed',
        node_output:
          lane >= 98 ? { error: { message: 'Exit code 1', retryable: false }, outputs: {} } : null,
      })),
    ).flat();

    const run = makeRun({
      nodeRuns: [
        makeNodeRun('trigger-run', { node_id: 'trigger', block_type: 'manual_trigger' }),
        {
          ...makeNodeRun(fanOutRunId),
          node_id: fanOutNodeId,
          block_type: 'fan_out',
          status: 'completed',
        },
        ...children,
      ],
      graph: {
        nodes: [
          { id: 'trigger', blockType: 'manual_trigger' },
          { id: fanOutNodeId, blockType: 'fan_out', label: 'Process Issues' },
        ],
        edges: [],
      },
    });

    const summary = mapFlowRunToSummary(run);

    // 1 trigger + 1 fan_out aggregate (300 children hidden)
    expect(summary.nodes).toHaveLength(2);
    expect(summary.totalNodeRuns).toBe(302); // trigger + fan_out + 300 children
    expect(summary.shownNodeRuns).toBe(2);

    const fanOutEntry = summary.nodes.find(isFanOutSummary);
    expect(fanOutEntry).toBeDefined();
    expect(fanOutEntry?.label).toBe('Process Issues');
    if (!fanOutEntry) throw new Error('Expected fan_out entry');

    expect(fanOutEntry.totalLanes).toBe(100);
    expect(fanOutEntry.completedLanes).toBe(98);
    expect(fanOutEntry.failedLanes).toBe(2);
    expect(fanOutEntry.failedLaneNodeRunIds).toHaveLength(2);

    // The IDs must be the actual failing body node IDs so an agent can drill in
    // with nodeRunId = failedLaneNodeRunIds[i] in a follow-up get_run call.
    // Lane 98's first failing node is child-98-0; lane 99's is child-99-0.
    expect(fanOutEntry.failedLaneNodeRunIds).toContain('child-98-0');
    expect(fanOutEntry.failedLaneNodeRunIds).toContain('child-99-0');
  });

  it('handles fan-out with all lanes completed', () => {
    const fanOutRunId = 'fo-run-2';
    const children = Array.from({ length: 10 }, (_, lane) => ({
      ...makeNodeRun(`child-${lane}`),
      block_type: 'run_command',
      parent_fan_out_node_run_id: fanOutRunId,
      lane_index: lane,
      status: 'completed',
    }));

    const run = makeRun({
      nodeRuns: [
        { ...makeNodeRun(fanOutRunId), block_type: 'fan_out', status: 'completed' },
        ...children,
      ],
    });

    const summary = mapFlowRunToSummary(run);
    const fanOut = summary.nodes.find(isFanOutSummary);
    if (!fanOut) throw new Error('Expected fan_out entry');

    expect(fanOut.totalLanes).toBe(10);
    expect(fanOut.completedLanes).toBe(10);
    expect(fanOut.failedLanes).toBe(0);
    expect(fanOut.failedLaneNodeRunIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EC8: In-progress run
// ---------------------------------------------------------------------------

describe('EC8: in-progress run with mixed node statuses', () => {
  it('shows run.status=running and elapsed durationMs for the run', () => {
    const now = Date.now();
    const startedAt = new Date(now - 5000).toISOString();

    const run = makeRun({
      status: 'running',
      started_at: startedAt,
      completed_at: null,
      nodeRuns: [
        makeNodeRun('nr-1', {
          status: 'completed',
          started_at: startedAt,
          completed_at: new Date(now - 3000).toISOString(),
        }),
        makeNodeRun('nr-2', {
          status: 'running',
          started_at: new Date(now - 3000).toISOString(),
          completed_at: null,
        }),
        makeNodeRun('nr-3', { status: 'pending', started_at: null, completed_at: null }),
      ],
    });

    const summary = mapFlowRunToSummary(run);

    expect(summary.run.status).toBe('running');
    expect(summary.run.completedAt).toBeNull();
    expect(summary.run.durationMs).not.toBeNull();
    expect(summary.run.durationMs).toBeGreaterThan(0);

    const statuses = summary.nodes.map((n) => n.status);
    expect(statuses).toContain('completed');
    expect(statuses).toContain('running');
    expect(statuses).toContain('pending');
  });
});

// ---------------------------------------------------------------------------
// EC11: Paused run
// ---------------------------------------------------------------------------

describe('EC11: paused run', () => {
  it('shows run.status=paused and awaiting_input node', () => {
    const run = makeRun({
      status: 'paused',
      completed_at: null,
      nodeRuns: [
        makeNodeRun('nr-1', { status: 'completed' }),
        makeNodeRun('nr-2', {
          status: 'awaiting_input',
          completed_at: null,
          node_id: 'approval-node',
          block_type: 'approval',
        }),
      ],
    });

    const summary = mapFlowRunToSummary(run);

    expect(summary.run.status).toBe('paused');
    const pausedNode = summary.nodes.find((n) => n.status === 'awaiting_input');
    expect(pausedNode).toBeDefined();
    expect(pausedNode?.blockType).toBe('approval');
  });
});

// ---------------------------------------------------------------------------
// EC12: Retried node
// ---------------------------------------------------------------------------

describe('EC12b: a lane retried after failing', () => {
  it('counts the lane by its replacement attempt, not the superseded failure', () => {
    const fanOutRunId = 'fo-retry';
    const lane = (id: string, status: string, attempt: number) => ({
      ...makeNodeRun(id, { status, attempt_number: attempt }),
      parent_fan_out_node_run_id: fanOutRunId,
      lane_index: 0,
    });
    const summarize = (retryStatus: string) =>
      mapFlowRunToSummary(
        makeRun({
          nodeRuns: [
            { ...makeNodeRun(fanOutRunId), block_type: 'fan_out', status: 'completed' },
            lane('old', 'superseded', 1),
            lane('new', retryStatus, 2),
          ],
        }),
      ).nodes.find(isFanOutSummary);

    expect(summarize('completed')).toMatchObject({ completedLanes: 1, failedLanes: 0 });
    expect(summarize('failed')).toMatchObject({
      completedLanes: 0,
      failedLanes: 1,
      failedLaneNodeRunIds: ['new'],
    });
  });
});

describe('EC12: retried node', () => {
  it('shows attemptNumber=2 for a retried node', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { attempt_number: 2, status: 'completed' })],
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0]).toMatchObject({ attemptNumber: 2 });
  });
});

// ---------------------------------------------------------------------------
// EC15: Error field shape mapping
// ---------------------------------------------------------------------------

describe('EC15: error field mapping', () => {
  it('extracts error.message and retryable from NodeOutput.error object', () => {
    const run = makeRun({
      nodeRuns: [
        makeNodeRun('nr-1', {
          status: 'failed',
          node_output: {
            error: { message: 'timeout', retryable: true },
            outputs: {},
            artifacts: [],
          },
        }),
      ],
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0]).toMatchObject({
      status: 'failed',
      error: 'timeout',
      retryable: true,
    });
  });

  it('returns null error and false retryable when node_output is null', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { status: 'completed', node_output: null })],
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0]).toMatchObject({ error: null, retryable: false });
  });
});

// ---------------------------------------------------------------------------
// EC16: Running node duration (started_at set, completed_at null)
// ---------------------------------------------------------------------------

describe('EC16: running node durationMs', () => {
  it('computes elapsed durationMs for a node that started but has not completed', () => {
    const now = Date.now();
    const startedAt = new Date(now - 2000).toISOString();

    const run = makeRun({
      nodeRuns: [
        makeNodeRun('nr-1', { status: 'running', started_at: startedAt, completed_at: null }),
      ],
    });

    const summary = mapFlowRunToSummary(run);
    const node = summary.nodes[0];
    expect(node.durationMs).not.toBeNull();
    expect(node.durationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// EC17: Pending node with null timestamps
// ---------------------------------------------------------------------------

describe('EC17: pending node null timestamps', () => {
  it('returns durationMs=null when both started_at and completed_at are null', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { status: 'pending', started_at: null, completed_at: null })],
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0].durationMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

describe('label resolution', () => {
  it('uses the label from the graph snapshot', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { node_id: 'cmd-node', block_type: 'run_command' })],
      graph: {
        nodes: [{ id: 'cmd-node', blockType: 'run_command', label: 'Run Tests' }],
        edges: [],
      },
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0].label).toBe('Run Tests');
  });

  it('falls back to display name when node has no label', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { node_id: 'cmd-node', block_type: 'run_command' })],
      graph: {
        nodes: [{ id: 'cmd-node', blockType: 'run_command' }],
        edges: [],
      },
    });

    const summary = mapFlowRunToSummary(run);
    // formatFlowNodeLabel falls back to FLOW_BLOCK_DISPLAY_LABELS or raw blockType
    expect(typeof summary.nodes[0].label).toBe('string');
    expect(summary.nodes[0].label.length).toBeGreaterThan(0);
  });

  it('falls back to blockType when node not in graph', () => {
    const run = makeRun({
      nodeRuns: [makeNodeRun('nr-1', { node_id: 'missing-node', block_type: 'run_command' })],
      graph: { nodes: [], edges: [] },
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes[0].label).toBe('run_command');
  });
});

// ---------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------

describe('node summary capping', () => {
  it(`caps entries at ${MAX_SUMMARY_NODES} and reports totalNodeRuns`, () => {
    const nodeRuns = Array.from({ length: MAX_SUMMARY_NODES + 10 }, (_, i) =>
      makeNodeRun(`nr-${i}`, { node_id: `n${i}` }),
    );
    const run = makeRun({ nodeRuns });

    const summary = mapFlowRunToSummary(run);
    expect(summary.nodes).toHaveLength(MAX_SUMMARY_NODES);
    expect(summary.totalNodeRuns).toBe(MAX_SUMMARY_NODES + 10);
    expect(summary.shownNodeRuns).toBe(MAX_SUMMARY_NODES);
  });
});

// ---------------------------------------------------------------------------
// Run-level duration
// ---------------------------------------------------------------------------

describe('run-level durationMs', () => {
  it('computes exact ms from started_at to completed_at', () => {
    const run = makeRun({
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:12.345Z',
    });

    const summary = mapFlowRunToSummary(run);
    expect(summary.run.durationMs).toBe(12345);
  });

  it('returns null when started_at is null', () => {
    const run = makeRun({ started_at: null, completed_at: null });
    const summary = mapFlowRunToSummary(run);
    expect(summary.run.durationMs).toBeNull();
  });
});
