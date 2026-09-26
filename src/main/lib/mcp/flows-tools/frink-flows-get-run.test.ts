/**
 * Handler-level tests for frink_flows_get_run.
 *
 * Tests EC4 (invalid UUID), EC5 (wrong-user 404), EC6 (unknown nodeRunId),
 * EC7 (null node_output), EC9 (rate limit), EC13 (network error),
 * EC14 (UI registry key exists).
 */

import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must match the full module surface that flows-tools/index.ts imports
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  getFlowRun: vi.fn(),
  getFlow: vi.fn(),
  createFlow: vi.fn(),
  createFlowVersion: vi.fn(),
  deleteFlow: vi.fn(),
  listFlows: vi.fn(),
  listFlowRuns: vi.fn(),
  listFlowRunsForFlow: vi.fn(),
  listBatchPlanTemplates: vi.fn(),
  listFlowBatchRuns: vi.fn(),
  listFlowBatchStages: vi.fn(),
  sendBatchMessage: vi.fn(),
  startFlowBatch: vi.fn(),
  addStageRuns: vi.fn(),
  defineFlowBatchStages: vi.fn(),
  startFlowRun: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  discoverCustomNodes: vi.fn(() => ({ nodes: [], errors: [] })),
  invalidateCustomNodesDiscoveryCache: vi.fn(),
}));

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../flows/mcp-cloud-shim', () => ({
  getFlowRun: state.getFlowRun,
  getFlow: state.getFlow,
  createFlow: state.createFlow,
  createFlowVersion: state.createFlowVersion,
  deleteFlow: state.deleteFlow,
  listFlows: state.listFlows,
  listFlowRuns: state.listFlowRuns,
  listFlowRunsForFlow: state.listFlowRunsForFlow,
  listBatchPlanTemplates: state.listBatchPlanTemplates,
  listFlowBatchRuns: state.listFlowBatchRuns,
  listFlowBatchStages: state.listFlowBatchStages,
  sendBatchMessage: state.sendBatchMessage,
  startFlowBatch: state.startFlowBatch,
  addStageRuns: state.addStageRuns,
  defineFlowBatchStages: state.defineFlowBatchStages,
  startFlowRun: state.startFlowRun,
}));
vi.mock('node:fs/promises', () => ({
  mkdir: state.mkdir,
  writeFile: state.writeFile,
  rm: state.rm,
  stat: state.stat,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/home/testuser',
}));
vi.mock('../../custom-nodes/discovery', () => ({
  discoverCustomNodes: state.discoverCustomNodes,
  invalidateCustomNodesDiscoveryCache: state.invalidateCustomNodesDiscoveryCache,
}));

import { GET_RUN_MIN_TIMEOUT_MS, handleFlowsToolCall, resetFlowsGetRunCount } from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Local-first IDs are cuid2 short ids, not UUIDs — fixtures use cuid2 shapes so the
// happy path exercises the loosened (non-UUID) validation, not a coincidental UUID.
const VALID_RUN_ID = 'mq7vqzr0om5lnt7kpa9xbrun';
const VALID_NODE_RUN_ID = 'mq7vqzr0om5lnt7kpa9xnode';

function makeFlowRunResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_RUN_ID,
    flow_version_id: 'mq7vqzr0om5lnt7kpa9xfver',
    user_id: 'user-1',
    status: 'completed',
    trigger_context: null,
    idempotency_key: null,
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:05.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    nodeRuns: [],
    graph: null,
    ...overrides,
  };
}

function makeNodeRunEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    flow_run_id: VALID_RUN_ID,
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
// Test helpers
// ---------------------------------------------------------------------------

async function callGetRun(args: Record<string, unknown>, executionId?: string) {
  return handleFlowsToolCall('frink_flows_get_run', args, executionId);
}

function parseResult(result: Awaited<ReturnType<typeof callGetRun>>) {
  if (!result) throw new Error('null result');
  if (result.content[0].type !== 'text') throw new Error('Expected text content');
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// EC4: Empty runId rejected (cuid2 ids are non-empty strings, not UUIDs)
// ---------------------------------------------------------------------------

describe('EC4: empty runId', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns a validation error without calling the API', async () => {
    const result = await callGetRun({ runId: '' });
    expect(result?.isError).toBe(true);
    const text = result?.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('runId');
    expect(state.getFlowRun).not.toHaveBeenCalled();
  });

  it('returns a validation error for missing runId', async () => {
    const result = await callGetRun({});
    expect(result?.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EC5: Valid UUID but run belongs to another user (404 from server)
// ---------------------------------------------------------------------------

describe('EC5: run not found (other user / deleted run)', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns a helpful not-found error on 404', async () => {
    state.getFlowRun.mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND', message: 'Not found' }));

    const result = await callGetRun({ runId: VALID_RUN_ID });
    expect(result?.isError).toBe(true);
    const text = result?.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('not found');
    expect(text).toContain(VALID_RUN_ID);
  });
});

// ---------------------------------------------------------------------------
// EC6: nodeRunId provided but not in the run
// ---------------------------------------------------------------------------

describe('EC6: nodeRunId not in run', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns nodeDetail.error (not a crash) when nodeRunId not found', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse({ nodeRuns: [] }));

    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: VALID_NODE_RUN_ID });
    expect(result?.isError).toBe(false); // tool succeeds, error is in payload
    const body = parseResult(result);
    expect(body.nodeDetail.error).toContain(VALID_NODE_RUN_ID);
  });
});

// ---------------------------------------------------------------------------
// EC7: nodeRunId provided for a node that hasn't started (node_output null)
// ---------------------------------------------------------------------------

describe('EC7: node_output is null', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns nodeDetail with null outputs and a message', async () => {
    state.getFlowRun.mockResolvedValueOnce(
      makeFlowRunResponse({
        nodeRuns: [makeNodeRunEntry(VALID_NODE_RUN_ID, { status: 'pending', node_output: null })],
      }),
    );

    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: VALID_NODE_RUN_ID });
    const body = parseResult(result);
    expect(body.nodeDetail.outputs).toBeNull();
    expect(body.nodeDetail.status).toBe('pending');
    expect(typeof body.nodeDetail.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// EC9: Rate limit — 20 calls per session
// ---------------------------------------------------------------------------

describe('EC9: rate limiting', () => {
  const SESSION = 'test-session-rate-limit';

  afterEach(() => resetFlowsGetRunCount(SESSION));

  it('allows up to 20 calls per session and blocks the 21st', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse());

    // First 20 calls should succeed
    for (let i = 0; i < 20; i++) {
      const result = await callGetRun({ runId: VALID_RUN_ID }, SESSION);
      expect(result?.isError).toBe(false);
    }

    // 21st call is rate-limited
    const blocked = await callGetRun({ runId: VALID_RUN_ID }, SESSION);
    expect(blocked?.isError).toBe(true);
    const text = blocked?.content[0].type === 'text' ? blocked.content[0].text : '';
    expect(text).toContain('Rate limit');
  });

  it('resets the counter after resetFlowsGetRunCount', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse());

    for (let i = 0; i < 20; i++) {
      await callGetRun({ runId: VALID_RUN_ID }, SESSION);
    }

    resetFlowsGetRunCount(SESSION);

    // Should work again after reset
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse());
    const result = await callGetRun({ runId: VALID_RUN_ID }, SESSION);
    expect(result?.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC13: Network error (e.g. fetch timeout)
// ---------------------------------------------------------------------------

describe('EC13: network/fetch error', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns an error message on network failure', async () => {
    state.getFlowRun.mockRejectedValueOnce(new Error('AbortError: fetch timed out'));

    const result = await callGetRun({ runId: VALID_RUN_ID });
    expect(result?.isError).toBe(true);
    const text = result?.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Failed to fetch flow run');
    expect(text).toContain('AbortError');
  });
});

// ---------------------------------------------------------------------------
// Global rate limit bucket (no executionId) — the standalone Claude Code CLI path
//
// Calls without an executionId fall to GLOBAL_GET_RUN_SESSION_KEY.
// Every standalone CLI call shares this single bucket.
// ---------------------------------------------------------------------------

describe('Global rate limit bucket (no executionId)', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('20 calls without executionId exhaust the global bucket and the 21st is blocked', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse());

    for (let i = 0; i < 20; i++) {
      const result = await callGetRun({ runId: VALID_RUN_ID }); // no executionId
      expect(result?.isError).toBe(false);
    }

    // Global bucket now exhausted — no executionId → same global key
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse());
    const blocked = await callGetRun({ runId: VALID_RUN_ID });
    expect(blocked?.isError).toBe(true);
    const text = blocked?.content[0].type === 'text' ? blocked.content[0].text : '';
    expect(text).toContain('Rate limit');
  });

  it('exhausting the global bucket does NOT block per-session (executionId) calls', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse());

    // Exhaust global bucket
    for (let i = 0; i < 20; i++) {
      await callGetRun({ runId: VALID_RUN_ID }); // no executionId
    }

    // A call with its own executionId has an independent bucket — should succeed
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse());
    const result = await callGetRun({ runId: VALID_RUN_ID }, 'frink-session-isolated');
    expect(result?.isError).toBe(false);

    resetFlowsGetRunCount('frink-session-isolated');
  });

  it('exhausting a per-session bucket does NOT block the global bucket', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse());
    const SESSION = 'isolated-frink-session';

    // Exhaust per-session bucket
    for (let i = 0; i < 20; i++) {
      await callGetRun({ runId: VALID_RUN_ID }, SESSION);
    }
    const blocked = await callGetRun({ runId: VALID_RUN_ID }, SESSION);
    expect(blocked?.isError).toBe(true);

    // Global bucket (no executionId) is unaffected
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse());
    const globalResult = await callGetRun({ runId: VALID_RUN_ID }); // no executionId
    expect(globalResult?.isError).toBe(false);

    resetFlowsGetRunCount(SESSION);
  });
});

// ---------------------------------------------------------------------------
// Fan-out child drill-in
//
// failedLaneNodeRunIds contains IDs of fan-out body nodes (children with
// parent_fan_out_node_run_id !== null). Agents are expected to pass these IDs
// as nodeRunId to inspect the failing lane's output — verify this resolves.
// ---------------------------------------------------------------------------

describe('Fan-out child drill-in via failedLaneNodeRunIds', () => {
  afterEach(() => resetFlowsGetRunCount());

  const FAN_OUT_RUN_ID = '550e8400-e29b-41d4-a716-446655440010';
  const FAILING_CHILD_RUN_ID = '550e8400-e29b-41d4-a716-446655440020';

  function makeFanOutRunResponse() {
    return makeFlowRunResponse({
      nodeRuns: [
        // Fan-out node itself — top-level
        makeNodeRunEntry(FAN_OUT_RUN_ID, { block_type: 'fan_out', status: 'failed' }),
        // Failing lane body node (child with parent_fan_out_node_run_id set)
        makeNodeRunEntry(FAILING_CHILD_RUN_ID, {
          block_type: 'run_command',
          status: 'failed',
          parent_fan_out_node_run_id: FAN_OUT_RUN_ID,
          lane_index: 0,
          node_output: {
            outputs: { exitCode: 1, _rawStdout: 'Error: process exited with code 1' },
            error: { message: 'Exit code 1', retryable: false },
          },
        }),
        // Sibling lane body node (succeeds)
        makeNodeRunEntry('550e8400-e29b-41d4-a716-446655440021', {
          block_type: 'run_command',
          status: 'completed',
          parent_fan_out_node_run_id: FAN_OUT_RUN_ID,
          lane_index: 1,
          node_output: { outputs: { exitCode: 0 }, error: null },
        }),
      ],
    });
  }

  it('resolves nodeDetail for a fan-out child (parent_fan_out_node_run_id !== null)', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFanOutRunResponse());

    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: FAILING_CHILD_RUN_ID });
    const body = parseResult(result);

    expect(result?.isError).toBe(false);
    expect(body.nodeDetail).not.toBeNull();
    expect(body.nodeDetail.nodeRunId).toBe(FAILING_CHILD_RUN_ID);
    expect(body.nodeDetail.outputs).toMatchObject({ exitCode: 1 });
    expect(body.nodeDetail.truncated).toBe(false);
  });

  it('summary still shows the fan-out aggregate (not individual children) alongside nodeDetail', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFanOutRunResponse());

    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: FAILING_CHILD_RUN_ID });
    const body = parseResult(result);

    // Only 1 top-level node: the fan_out aggregate (children are hidden)
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].blockType).toBe('fan_out');

    // The aggregate should reflect the failed lane
    expect(body.nodes[0].failedLanes).toBe(1);
    expect(body.nodes[0].completedLanes).toBe(1);
    expect(body.nodes[0].failedLaneNodeRunIds).toContain(FAILING_CHILD_RUN_ID);
  });

  it('returns nodeDetail.error when the fan-out child nodeRunId is not found in the run', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFanOutRunResponse());

    const WRONG_ID = '550e8400-e29b-41d4-a716-446655440099';
    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: WRONG_ID });
    const body = parseResult(result);

    expect(result?.isError).toBe(false);
    expect(body.nodeDetail.error).toContain(WRONG_ID);
  });
});

// ---------------------------------------------------------------------------
// EC14: UI registry entry exists
// ---------------------------------------------------------------------------

describe('EC14: UI registry', () => {
  it('tool-frink_flows_get_run is present in FLOWS_TOOLS', async () => {
    const { FLOWS_TOOLS } = await import('./index');
    const names = FLOWS_TOOLS.map((t) => t.name);
    expect(names).toContain('frink_flows_get_run');
  });
});

// ---------------------------------------------------------------------------
// Happy path: summary response shape
// ---------------------------------------------------------------------------

describe('happy path: summary response', () => {
  afterEach(() => resetFlowsGetRunCount());

  it('returns a well-formed summary with nodeDetail null when no nodeRunId', async () => {
    state.getFlowRun.mockResolvedValueOnce(
      makeFlowRunResponse({
        nodeRuns: [
          makeNodeRunEntry('nr-1', {
            node_id: 'cmd',
            block_type: 'run_command',
            status: 'completed',
            node_output: { outputs: { exitCode: 0 }, error: null },
          }),
        ],
      }),
    );

    const result = await callGetRun({ runId: VALID_RUN_ID });
    const body = parseResult(result);

    expect(body.run.id).toBe(VALID_RUN_ID);
    expect(body.run.status).toBe('completed');
    expect(body.nodes).toHaveLength(1);
    expect(body.nodeDetail).toBeNull();
    expect(typeof body.totalNodeRuns).toBe('number');
  });

  it('returns nodeDetail with outputs when nodeRunId matches', async () => {
    state.getFlowRun.mockResolvedValueOnce(
      makeFlowRunResponse({
        nodeRuns: [
          makeNodeRunEntry(VALID_NODE_RUN_ID, {
            node_output: {
              outputs: { exitCode: 0, _rawStdout: 'hello world' },
              error: null,
            },
          }),
        ],
      }),
    );

    const result = await callGetRun({ runId: VALID_RUN_ID, nodeRunId: VALID_NODE_RUN_ID });
    const body = parseResult(result);

    expect(body.nodeDetail).not.toBeNull();
    expect(body.nodeDetail.nodeRunId).toBe(VALID_NODE_RUN_ID);
    expect(body.nodeDetail.outputs).toMatchObject({ exitCode: 0, _rawStdout: 'hello world' });
    expect(body.nodeDetail.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wait: true — blocking await
// ---------------------------------------------------------------------------

describe('wait: true blocking await', () => {
  afterEach(() => {
    resetFlowsGetRunCount();
    state.getFlowRun.mockReset();
  });

  it('returns immediately when run is already completed (no polling)', async () => {
    state.getFlowRun.mockResolvedValue(makeFlowRunResponse({ status: 'completed' }));

    const result = await callGetRun({ runId: VALID_RUN_ID, wait: true });
    const body = parseResult(result);

    expect(result?.isError).toBe(false);
    expect(body.run.status).toBe('completed');
    expect(body.waited).toBeUndefined();
  });

  it('polls until run reaches terminal state and includes waited: true', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'completed' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });

      // Advance past the first poll delay (2s)
      await vi.advanceTimersByTimeAsync(2_000);
      // Advance past the second poll delay (3s = 2000 * 1.5)
      await vi.advanceTimersByTimeAsync(3_000);

      const result = await promise;
      const body = parseResult(result);

      expect(result?.isError).toBe(false);
      expect(body.run.status).toBe('completed');
      expect(body.waited).toBe(true);
      expect(body.waitTimedOut).toBeUndefined();
      // 1 initial fetch + 2 polls inside pollUntilDone
      expect(state.getFlowRun).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns early with earlyReturn when run is paused', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'paused' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      const body = parseResult(result);

      expect(result?.isError).toBe(false);
      expect(body.run.status).toBe('paused');
      expect(body.waited).toBe(true);
      expect(body.earlyReturn).toBe(true);
      expect(body.earlyReturnReason).toContain('paused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns early with earlyReturn when run is awaiting_input', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'awaiting_input' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      const body = parseResult(result);

      expect(body.earlyReturn).toBe(true);
      expect(body.earlyReturnReason).toContain('awaiting_input');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns with waitTimedOut when timeout expires', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun.mockResolvedValue(makeFlowRunResponse({ status: 'running' }));

      const promise = callGetRun({
        runId: VALID_RUN_ID,
        wait: true,
        timeoutMs: GET_RUN_MIN_TIMEOUT_MS,
      });

      // Advance well past the minimum timeout
      await vi.advanceTimersByTimeAsync(GET_RUN_MIN_TIMEOUT_MS + 5_000);

      const result = await promise;
      const body = parseResult(result);

      expect(result?.isError).toBe(false);
      expect(body.run.status).toBe('running');
      expect(body.waited).toBe(true);
      expect(body.waitTimedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps timeoutMs to the maximum', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse({ status: 'completed' }));

    const result = await callGetRun({
      runId: VALID_RUN_ID,
      wait: true,
      timeoutMs: 999_999_999,
    });
    const body = parseResult(result);

    // Completes immediately since run is already done — just ensures no error from huge timeout
    expect(result?.isError).toBe(false);
    expect(body.run.status).toBe('completed');
  });

  it('combines wait: true with nodeRunId to get detail after completion', async () => {
    vi.useFakeTimers();
    try {
      const completedRun = makeFlowRunResponse({
        status: 'completed',
        nodeRuns: [
          makeNodeRunEntry(VALID_NODE_RUN_ID, {
            status: 'completed',
            node_output: { outputs: { exitCode: 0, _rawStdout: 'done' }, error: null },
          }),
        ],
      });

      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(completedRun);

      const promise = callGetRun({ runId: VALID_RUN_ID, nodeRunId: VALID_NODE_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      const body = parseResult(result);

      expect(body.waited).toBe(true);
      expect(body.nodeDetail).not.toBeNull();
      expect(body.nodeDetail.nodeRunId).toBe(VALID_NODE_RUN_ID);
      expect(body.nodeDetail.outputs._rawStdout).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns failed run status after wait without isError', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'failed' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      const body = parseResult(result);

      expect(result?.isError).toBe(false);
      expect(body.run.status).toBe('failed');
      expect(body.waited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns error when polling throws a network error', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockRejectedValueOnce(new Error('Connection reset'));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;

      expect(result?.isError).toBe(true);
      expect(result?.content[0]?.text).toContain('Connection reset');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count as "waited" when wait is false', async () => {
    state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }));

    const result = await callGetRun({ runId: VALID_RUN_ID, wait: false });
    const body = parseResult(result);

    expect(body.run.status).toBe('running');
    expect(body.waited).toBeUndefined();
    expect(state.getFlowRun).toHaveBeenCalledTimes(1);
  });

  // EW1: internal polls bypass rate limiter — only 1 slot consumed per wait call
  it('consumes only 1 rate limit slot even when polling multiple times', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'running' }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'completed' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true }, 'ew1-session');
      await vi.advanceTimersByTimeAsync(2_000 + 3_000 + 4_500);
      await promise;

      // 4 fetches total but only 1 rate limit slot consumed — 19 remaining
      for (let i = 0; i < 19; i++) {
        state.getFlowRun.mockResolvedValueOnce(makeFlowRunResponse({ status: 'completed' }));
        const r = await callGetRun({ runId: VALID_RUN_ID }, 'ew1-session');
        expect(r?.isError).toBe(false);
      }

      // 21st call (20th slot already used by the 19 above + 1 from wait) should be blocked
      const blocked = await callGetRun({ runId: VALID_RUN_ID }, 'ew1-session');
      expect(blocked?.isError).toBe(true);
      expect(blocked?.content[0]?.text).toContain('Rate limit');
    } finally {
      vi.useRealTimers();
    }
  });

  // EW2: timeoutMs below minimum gets clamped up
  it('clamps timeoutMs below minimum to GET_RUN_MIN_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun.mockResolvedValue(makeFlowRunResponse({ status: 'running' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true, timeoutMs: 1 });

      // 1ms would be instant — but clamped to 5000ms, so after 2s first poll the
      // next poll delay (3s) would exceed deadline, causing timeout
      await vi.advanceTimersByTimeAsync(GET_RUN_MIN_TIMEOUT_MS + 1_000);

      const result = await promise;
      const body = parseResult(result);

      expect(result?.isError).toBe(false);
      expect(body.waited).toBe(true);
      expect(body.waitTimedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // EW3: unknown/future status continues polling until timeout
  it('treats unknown run status as non-terminal and keeps polling', async () => {
    vi.useFakeTimers();
    try {
      state.getFlowRun
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'queued' as string }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'queued' as string }))
        .mockResolvedValueOnce(makeFlowRunResponse({ status: 'completed' }));

      const promise = callGetRun({ runId: VALID_RUN_ID, wait: true });
      await vi.advanceTimersByTimeAsync(2_000 + 3_000);

      const result = await promise;
      const body = parseResult(result);

      expect(body.run.status).toBe('completed');
      expect(body.waited).toBe(true);
      expect(state.getFlowRun).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // EW4: 404 on initial fetch with wait: true — no poll loop entered
  it('returns 404 error immediately with wait: true and does not enter poll loop', async () => {
    state.getFlowRun.mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND', message: 'Not Found' }));

    const result = await callGetRun({ runId: VALID_RUN_ID, wait: true });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Flow run not found');
    expect(state.getFlowRun).toHaveBeenCalledTimes(1);
  });
});
