// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowExecutionEvent } from '../../shared/types/flow';

// --- Hoisted mocks ---

const mockIsDesktopApp = vi.hoisted(() => vi.fn(() => true));

// Create a test store via inline require so it can be used in vi.mock factory
// (vi.hoisted runs before module initialization, so top-level imports can't be used there).
const testStore = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createStore } = require('jotai') as typeof import('jotai');
  return createStore();
});

/** Keys passed to `nodeExecAtomFamily` during a test (hook + direct `testStore.set` in specs). */
const trackedNodeExecKeys = vi.hoisted(() => new Set<string>());

vi.mock('../lib/utils/platform', () => ({
  isDesktopApp: mockIsDesktopApp,
}));

vi.mock('../lib/jotai-store', () => ({
  appStore: testStore,
}));

vi.mock('../features/flows/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/flows/atoms')>();
  return {
    ...actual,
    nodeExecAtomFamily: (key: string) => {
      trackedNodeExecKeys.add(key);
      return actual.nodeExecAtomFamily(key);
    },
  };
});

// Import atoms and hook AFTER mocks are registered.
import type { DbFlowRunWithNodeRuns, DbNodeRun } from '../../shared/types/flow-run';
import type { FlowEdge, FlowGraph } from '../../shared/lib/validate-flow-graph';
import {
  flowCanvasExecutionAtom,
  flowLoopProgressAtomFamily,
  nodeExecAtomFamily,
} from '../features/flows/atoms';
import {
  resetFlowCanvasExecutionSharedState,
  useFlowCanvasExecution,
} from './use-flow-canvas-execution';

// --- Desktop API helpers ---

/** Mirrors preload: multiple `onSocketFlowExecutionEvent` subscriptions each receive the same event. */
const executionEventListeners: Array<(event: FlowExecutionEvent) => void> = [];
const mockUnsubscribe = vi.fn();

function setupDesktopApi() {
  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: {
      onSocketFlowExecutionEvent: (cb: (event: FlowExecutionEvent) => void) => {
        executionEventListeners.push(cb);
        return () => {
          mockUnsubscribe();
          const i = executionEventListeners.indexOf(cb);
          if (i >= 0) executionEventListeners.splice(i, 1);
        };
      },
    },
  });
}

function makeEvent(
  overrides: Partial<FlowExecutionEvent> & { eventType: FlowExecutionEvent['eventType'] },
): FlowExecutionEvent {
  return {
    flowId: 'flow-1',
    flowRunId: 'run-1',
    flowName: 'My Flow',
    runStatus: 'running',
    ...overrides,
  };
}

function dispatch(
  overrides: Partial<FlowExecutionEvent> & { eventType: FlowExecutionEvent['eventType'] },
) {
  const ev = makeEvent(overrides);
  act(() => {
    for (const cb of [...executionEventListeners]) {
      cb(ev);
    }
  });
}

function getNodeState(flowId: string, nodeId: string) {
  return testStore.get(nodeExecAtomFamily(`${flowId}:${nodeId}`));
}

function getFlowExecState(flowId: string) {
  return testStore.get(flowCanvasExecutionAtom)[flowId];
}

function getFlowLoopProgress(flowId: string) {
  return testStore.get(flowLoopProgressAtomFamily(flowId));
}

function makeDbNodeRun(
  overrides: Partial<DbNodeRun> & Pick<DbNodeRun, 'node_id' | 'status'>,
): DbNodeRun {
  return {
    id: crypto.randomUUID(),
    flow_run_id: 'run-rehydrate',
    block_type: 'agent',
    node_output: null,
    attempt_number: 1,
    started_at: null,
    completed_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    lane_index: null,
    parent_fan_out_node_run_id: null,
    ...overrides,
  };
}

/** Explicit Fan Out body followed by an outside continuation. */
function graphFanOutChain(fanOutId: string, bodyIds: string[]): FlowGraph {
  const continuationId = `${fanOutId}-after`;
  const nodes = [
    { id: fanOutId, blockType: 'fan_out' as const },
    ...bodyIds.map((id) => ({ id, blockType: 'agent' as const, parentId: fanOutId })),
    { id: continuationId, blockType: 'agent' as const },
  ];
  const edges: FlowEdge[] = [];
  let src = fanOutId;
  for (let i = 0; i < bodyIds.length; i++) {
    const tgt = bodyIds[i];
    edges.push({ id: `e-${fanOutId}-${i}`, source: src, target: tgt });
    src = tgt;
  }
  edges.push({ id: `e-${fanOutId}-after`, source: src, target: continuationId });
  return { nodes, edges };
}

/** Trigger → fetch → fan_out → … body (sequential fan_out with upstream nodes). */
function graphTriggerFetchFanOutBody(): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', blockType: 'manual_trigger' },
      { id: 'fetch-prs', blockType: 'fetch-github-prs' },
      { id: 'fo-node', blockType: 'fan_out' },
      { id: 'body-start', blockType: 'start_task', parentId: 'fo-node' },
      { id: 'body-agent', blockType: 'agent', parentId: 'fo-node' },
      { id: 'after', blockType: 'agent' },
    ],
    edges: [
      { id: 'e-t', source: 'trigger', target: 'fetch-prs' },
      { id: 'e-f', source: 'fetch-prs', target: 'fo-node' },
      { id: 'e-o', source: 'fo-node', target: 'body-start' },
      { id: 'e-s', source: 'body-start', target: 'body-agent' },
      { id: 'e-a', source: 'body-agent', target: 'after' },
    ],
  };
}

function makeRunningRunWithNodes(
  nodeRuns: DbNodeRun[],
  graph: FlowGraph | null = null,
): DbFlowRunWithNodeRuns {
  return {
    id: 'run-rehydrate',
    flow_version_id: 'fv-1',
    status: 'running',
    trigger_context: null,
    idempotency_key: null,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    graph,
    nodeRuns,
  };
}

function resetNodeExecAtomFamilyState(): void {
  const keys = [...trackedNodeExecKeys];
  for (const key of keys) {
    testStore.set(nodeExecAtomFamily(key), null);
  }
  trackedNodeExecKeys.clear();
}

// --- Tests ---

describe('useFlowCanvasExecution', () => {
  beforeEach(() => {
    executionEventListeners.length = 0;
    resetFlowCanvasExecutionSharedState();
    mockIsDesktopApp.mockReturnValue(true);
    mockUnsubscribe.mockReset();
    setupDesktopApi();
    // Reset atoms between tests
    testStore.set(flowCanvasExecutionAtom, {});
    resetNodeExecAtomFamilyState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers listener on mount', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    expect(executionEventListeners).toHaveLength(1);
  });

  it('calls unsubscribe on unmount', () => {
    const { unmount } = renderHook(() => useFlowCanvasExecution('flow-1'));
    expect(executionEventListeners).toHaveLength(1);
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledOnce();
    expect(executionEventListeners).toHaveLength(0);
  });

  it('run_started sets isLive: true for the flow', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-42' });
    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-42',
      isLive: true,
      isHistoricalInspection: false,
    });
  });

  it('batch_completed (no flowRunId) is ignored — no crash, no canvas paint', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-42' });

    // The batch summary event has no single run and must not disturb the
    // live run's canvas state or throw on its missing flowRunId.
    dispatch({ eventType: 'batch_completed', flowRunId: undefined, batchId: 'b1' });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-42',
      isLive: true,
      isHistoricalInspection: false,
    });
  });

  it('run_started ignores events for other flows', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowId: 'flow-99', flowRunId: 'run-99' });
    expect(getFlowExecState('flow-1')).toBeUndefined();
  });

  it('ignores node_started when flowRunId does not match the active run after run_started', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-b' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-a',
      nodeId: 'node-stale',
      blockType: 'agent',
    });
    expect(getNodeState('flow-1', 'node-stale')).toBeNull();
  });

  it('ignores node_started after run_completed (run no longer live)', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'run_completed', runStatus: 'completed' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-1',
      nodeId: 'node-late',
      blockType: 'agent',
    });
    expect(getNodeState('flow-1', 'node-late')).toBeNull();
  });

  it('ignores node_completed for a stale flowRunId after a newer run_started', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-b' });
    testStore.set(nodeExecAtomFamily('flow-1:node-stale-complete'), {
      status: 'running',
      runningUntil: Date.now() - 100,
    });
    dispatch({
      eventType: 'node_completed',
      flowRunId: 'run-a',
      nodeId: 'node-stale-complete',
      blockType: 'agent',
    });
    expect(getNodeState('flow-1', 'node-stale-complete')?.status).toBe('running');
  });

  it('ignores stale run_completed when a newer run_started is active', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-b' });
    dispatch({
      eventType: 'run_completed',
      flowRunId: 'run-a',
      runStatus: 'completed',
    });
    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-b',
      isLive: true,
      isHistoricalInspection: false,
    });
  });

  it('ignores node_failed for a stale flowRunId after a newer run_started', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-b' });
    testStore.set(nodeExecAtomFamily('flow-1:node-stale-fail'), {
      status: 'running',
      runningUntil: Date.now() - 100,
    });
    dispatch({
      eventType: 'node_failed',
      flowRunId: 'run-a',
      nodeId: 'node-stale-fail',
      blockType: 'agent',
    });
    expect(getNodeState('flow-1', 'node-stale-fail')?.status).toBe('running');
  });

  it('node_started sets node atom to running', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'node_started', nodeId: 'node-a', blockType: 'agent' });
    const state = getNodeState('flow-1', 'node-a');
    expect(state?.status).toBe('running');
    expect(state?.runningUntil).toBeGreaterThan(Date.now());
  });

  it('node_started includes loopIteration when provided', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({
      eventType: 'node_started',
      nodeId: 'node-b',
      blockType: 'fan_out',
      loopIteration: 3,
    });
    expect(getNodeState('flow-1', 'node-b')?.loopIteration).toBe(3);
  });

  it('node_started includes loopTotalCount when provided (fan-out progress chip)', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({
      eventType: 'node_started',
      nodeId: 'node-body',
      blockType: 'agent',
      loopIteration: 2,
      loopTotalCount: 7,
    });
    const s = getNodeState('flow-1', 'node-body');
    expect(s?.loopIteration).toBe(2);
    expect(s?.loopTotalCount).toBe(7);
  });

  it('node_started with fanOutNodeId mirrors loop progress onto the parent fan_out graph node', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-1',
      nodeId: 'body-agent',
      blockType: 'agent',
      loopIteration: 1,
      loopTotalCount: 5,
      fanOutNodeId: 'fan-out-graph-node',
    });
    const body = getNodeState('flow-1', 'body-agent');
    const parent = getNodeState('flow-1', 'fan-out-graph-node');
    expect(body?.status).toBe('running');
    expect(body?.loopIteration).toBe(1);
    expect(parent?.status).toBe('running');
    expect(parent?.loopIteration).toBe(1);
    expect(parent?.loopTotalCount).toBe(5);
  });

  it('node_started does not update parent fan_out atom when fanOutNodeId is set but loopIteration is absent', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-1',
      nodeId: 'body-x',
      blockType: 'agent',
      fanOutNodeId: 'fo-parent',
    });
    expect(getNodeState('flow-1', 'body-x')?.status).toBe('running');
    expect(getNodeState('flow-1', 'fo-parent')).toBeNull();
  });

  it('node_completed preserves loopIteration and loopTotalCount from running state', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    testStore.set(nodeExecAtomFamily('flow-1:node-loop-done'), {
      status: 'running',
      loopIteration: 4,
      loopTotalCount: 10,
      runningUntil: Date.now() - 100,
    });
    dispatch({ eventType: 'node_completed', nodeId: 'node-loop-done', blockType: 'agent' });
    const s = getNodeState('flow-1', 'node-loop-done');
    expect(s?.status).toBe('completed');
    expect(s?.loopIteration).toBe(4);
    expect(s?.loopTotalCount).toBe(10);
  });

  it('node_completed immediately sets completed when past runningUntil', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    // Manually set a past runningUntil to simulate the min-display window already expired
    testStore.set(nodeExecAtomFamily('flow-1:node-c'), {
      status: 'running',
      runningUntil: Date.now() - 100,
    });
    dispatch({ eventType: 'node_completed', nodeId: 'node-c', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-c')?.status).toBe('completed');
  });

  it('node_failed sets node to failed', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    testStore.set(nodeExecAtomFamily('flow-1:node-d'), {
      status: 'running',
      runningUntil: Date.now() - 100,
    });
    dispatch({ eventType: 'node_failed', nodeId: 'node-d', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-d')?.status).toBe('failed');
  });

  it('node_skipped sets node to skipped', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    testStore.set(nodeExecAtomFamily('flow-1:node-e'), {
      status: 'running',
      runningUntil: Date.now() - 100,
    });
    dispatch({ eventType: 'node_skipped', nodeId: 'node-e', blockType: 'manual_trigger' });
    expect(getNodeState('flow-1', 'node-e')?.status).toBe('skipped');
  });

  it('run_completed sets isLive: false', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'run_completed', runStatus: 'completed' });
    expect(getFlowExecState('flow-1')?.isLive).toBe(false);
  });

  it('run_completed reconciles nodeStatuses from event', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({
      eventType: 'run_completed',
      runStatus: 'completed',
      nodeStatuses: {
        'node-x': { status: 'completed' },
        'node-y': { status: 'skipped' },
      },
    });
    expect(getNodeState('flow-1', 'node-x')?.status).toBe('completed');
    expect(getNodeState('flow-1', 'node-y')?.status).toBe('skipped');
  });

  it('run_completed nodeStatuses reconciliation preserves loopIteration and loopTotalCount', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-1',
      nodeId: 'fan-out',
      blockType: 'fan_out',
      loopIteration: 2,
      loopTotalCount: 29,
    });
    expect(getNodeState('flow-1', 'fan-out')?.loopIteration).toBe(2);
    dispatch({
      eventType: 'run_completed',
      flowRunId: 'run-1',
      runStatus: 'completed',
      nodeStatuses: { 'fan-out': { status: 'completed' } },
    });
    const st = getNodeState('flow-1', 'fan-out');
    expect(st?.status).toBe('completed');
    expect(st?.loopIteration).toBe(2);
    expect(st?.loopTotalCount).toBe(29);
  });

  it('run_started clears previous node atoms', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    // First run: set some node state
    dispatch({ eventType: 'node_started', nodeId: 'node-a', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-a')?.status).toBe('running');
    // Second run starts: node-a should be cleared
    dispatch({ eventType: 'run_started', flowRunId: 'run-2' });
    expect(getNodeState('flow-1', 'node-a')).toBeNull();
  });

  it('cleanup on unmount clears node atoms', () => {
    const { unmount } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'node_started', nodeId: 'node-f', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-f')?.status).toBe('running');
    unmount();
    expect(getNodeState('flow-1', 'node-f')).toBeNull();
  });

  it('cleanup on unmount removes run-level entry from flowCanvasExecutionAtom', () => {
    const { unmount } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    expect(getFlowExecState('flow-1')).toBeDefined();
    unmount();
    expect(getFlowExecState('flow-1')).toBeUndefined();
  });

  it('clearOverlay clears tracked node atoms and run-level state', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'node_started', nodeId: 'node-g', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-g')?.status).toBe('running');
    expect(getFlowExecState('flow-1')).toBeDefined();

    act(() => {
      result.current.clearOverlay();
    });

    expect(getNodeState('flow-1', 'node-g')).toBeNull();
    expect(getFlowExecState('flow-1')).toBeUndefined();
  });

  describe('flowLoopProgressAtomFamily (Run History loop badge)', () => {
    it('node_started with fanOutNodeId sets atom', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body-agent',
        blockType: 'agent',
        loopIteration: 2,
        loopTotalCount: 29,
        fanOutNodeId: 'fan-out',
      });
      expect(getFlowLoopProgress('flow-1')).toEqual({ loopIteration: 2, loopTotalCount: 29 });
    });

    it('run_completed clears atom', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body',
        blockType: 'agent',
        loopIteration: 1,
        loopTotalCount: 5,
        fanOutNodeId: 'fan',
      });
      expect(getFlowLoopProgress('flow-1')).not.toBeNull();
      dispatch({ eventType: 'run_completed', flowRunId: 'run-1', runStatus: 'completed' });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('clearOverlay clears atom', () => {
      const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body',
        blockType: 'agent',
        loopIteration: 0,
        loopTotalCount: 10,
        fanOutNodeId: 'fan',
      });
      expect(getFlowLoopProgress('flow-1')).not.toBeNull();
      act(() => {
        result.current.clearOverlay();
      });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('run_started clears atom', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      act(() => {
        testStore.set(flowLoopProgressAtomFamily('flow-1'), {
          loopIteration: 5,
          loopTotalCount: 10,
        });
      });
      dispatch({ eventType: 'run_started', flowRunId: 'run-new' });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('node_started without fanOutNodeId does not set atom (parallel / non-sequential path)', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'lane-body',
        blockType: 'agent',
        loopIteration: 2,
        loopTotalCount: 5,
      });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('run_failed clears atom', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body',
        blockType: 'agent',
        loopIteration: 1,
        loopTotalCount: 5,
        fanOutNodeId: 'fan',
      });
      expect(getFlowLoopProgress('flow-1')).not.toBeNull();
      dispatch({ eventType: 'run_failed', flowRunId: 'run-1', runStatus: 'failed' });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('run_cancelled clears atom', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body',
        blockType: 'agent',
        loopIteration: 1,
        loopTotalCount: 5,
        fanOutNodeId: 'fan',
      });
      expect(getFlowLoopProgress('flow-1')).not.toBeNull();
      dispatch({ eventType: 'run_cancelled', flowRunId: 'run-1', runStatus: 'cancelled' });
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('last unmount clears flowLoopProgressAtomFamily', () => {
      const { unmount } = renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'body',
        blockType: 'agent',
        loopIteration: 0,
        loopTotalCount: 10,
        fanOutNodeId: 'fan',
      });
      expect(getFlowLoopProgress('flow-1')).not.toBeNull();
      unmount();
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });

    it('viewRunOnCanvas does not set flowLoopProgressAtomFamily when merge has loop context', () => {
      const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
      const run = makeRunningRunWithNodes(
        [
          makeDbNodeRun({
            node_id: 'fo-node',
            status: 'completed',
            block_type: 'fan_out',
            node_output: { outputs: { totalCount: 10, currentIndex: 0 } },
          }),
          makeDbNodeRun({
            node_id: 'body-start',
            status: 'completed',
            block_type: 'start_task',
            attempt_number: 4,
          }),
          makeDbNodeRun({
            node_id: 'body-agent',
            status: 'running',
            block_type: 'agent',
            attempt_number: 4,
          }),
        ],
        graphFanOutChain('fo-node', ['body-start', 'body-agent']),
      );

      act(() => {
        result.current.viewRunOnCanvas(run);
      });

      expect(getNodeState('flow-1', 'fo-node')?.loopIteration).toBe(3);
      expect(getFlowLoopProgress('flow-1')).toBeNull();
    });
  });

  it('does nothing when isDesktopApp returns false', () => {
    mockIsDesktopApp.mockReturnValue(false);
    renderHook(() => useFlowCanvasExecution('flow-1'));
    expect(executionEventListeners).toHaveLength(0);
  });

  it('rehydrateFromRun sets isLive and node overlay from DB node runs', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'n-a', status: 'completed' }),
      makeDbNodeRun({ node_id: 'n-b', status: 'running' }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-rehydrate',
      isLive: true,
      isHistoricalInspection: false,
    });
    expect(getNodeState('flow-1', 'n-a')?.status).toBe('completed');
    expect(getNodeState('flow-1', 'n-b')?.status).toBe('running');
  });

  it('rehydrateFromRun is a no-op when run status is not running', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'n-x', status: 'running' })]),
      status: 'completed',
    };

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getFlowExecState('flow-1')).toBeUndefined();
    expect(getNodeState('flow-1', 'n-x')).toBeNull();
  });

  it('rehydrateFromRun rehydrates a paused run (active agent hand-off) like a running one', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    // The engine parks a run at 'paused' while an agent node is actively running.
    // Navigating away + back must repaint that overlay — the regression this guards.
    const run = {
      ...makeRunningRunWithNodes([
        makeDbNodeRun({ node_id: 'n-done', status: 'completed' }),
        makeDbNodeRun({ node_id: 'n-active', status: 'running' }),
      ]),
      status: 'paused' as const,
    };

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-rehydrate',
      isLive: true,
      isHistoricalInspection: false,
    });
    expect(getNodeState('flow-1', 'n-done')?.status).toBe('completed');
    expect(getNodeState('flow-1', 'n-active')?.status).toBe('running');
  });

  it('rehydrateFromRun repaints a paused run again after clearOverlay (navigate-away oscillation)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'n-osc', status: 'running' })]),
      status: 'paused' as const,
    };

    act(() => {
      result.current.rehydrateFromRun(run);
    });
    expect(getNodeState('flow-1', 'n-osc')?.status).toBe('running');

    // Simulate leaving the page: overlay cleared.
    act(() => {
      result.current.clearOverlay();
    });
    expect(getNodeState('flow-1', 'n-osc')).toBeNull();
    expect(getFlowExecState('flow-1')).toBeUndefined();

    // Return to the still-paused run: overlay must repaint, not stay blank.
    act(() => {
      result.current.rehydrateFromRun(run);
    });
    expect(getNodeState('flow-1', 'n-osc')?.status).toBe('running');
    expect(getFlowExecState('flow-1')?.isLive).toBe(true);
  });

  it('rehydrateFromRun is a no-op when flow already has canvas execution state', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-socket' });
    const run = makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'n-y', status: 'running' })]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-socket',
      isLive: true,
      isHistoricalInspection: false,
    });
    expect(getNodeState('flow-1', 'n-y')).toBeNull();
  });

  it('rehydrateFromRun merges fan-out lanes: any running lane yields running with max lane_index as loopIteration', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'fan-node', status: 'completed', lane_index: 0 }),
      makeDbNodeRun({ node_id: 'fan-node', status: 'running', lane_index: 2 }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'fan-node')?.status).toBe('running');
    expect(getNodeState('flow-1', 'fan-node')?.loopIteration).toBe(2);
    expect(getFlowLoopProgress('flow-1')).toBeNull();
  });

  it('rehydrateFromRun sets loopTotalCount from unique lane_index across parent (not row count)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const parentFanOut = 'parent-fan-out-node-run-uuid';
    // 3 lanes × 2 body chain nodes → 6 rows, but only 3 lanes.
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({
        node_id: 'start-in-lane',
        status: 'completed',
        lane_index: 0,
        parent_fan_out_node_run_id: parentFanOut,
      }),
      makeDbNodeRun({
        node_id: 'start-in-lane',
        status: 'completed',
        lane_index: 1,
        parent_fan_out_node_run_id: parentFanOut,
      }),
      makeDbNodeRun({
        node_id: 'start-in-lane',
        status: 'completed',
        lane_index: 2,
        parent_fan_out_node_run_id: parentFanOut,
      }),
      makeDbNodeRun({
        node_id: 'agent-in-lane',
        status: 'running',
        lane_index: 2,
        parent_fan_out_node_run_id: parentFanOut,
      }),
      makeDbNodeRun({
        node_id: 'agent-in-lane',
        status: 'completed',
        lane_index: 0,
        parent_fan_out_node_run_id: parentFanOut,
      }),
      makeDbNodeRun({
        node_id: 'agent-in-lane',
        status: 'completed',
        lane_index: 1,
        parent_fan_out_node_run_id: parentFanOut,
      }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const ag = getNodeState('flow-1', 'agent-in-lane');
    expect(ag?.status).toBe('running');
    expect(ag?.loopIteration).toBe(2);
    expect(ag?.loopTotalCount).toBe(3);
    expect(getFlowLoopProgress('flow-1')).toBeNull();
  });

  it('rehydrateFromRun: sequential fan-out body nodes (lane_index null) do not produce loop chip fields', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'seq-body', status: 'completed', lane_index: null }),
      makeDbNodeRun({
        node_id: 'seq-body',
        status: 'running',
        lane_index: null,
        parent_fan_out_node_run_id: null,
      }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const s = getNodeState('flow-1', 'seq-body');
    expect(s?.status).toBe('running');
    expect(s?.loopIteration).toBeUndefined();
    expect(s?.loopTotalCount).toBeUndefined();
  });

  it('rehydrateFromRun: fan_out node set to running when body nodes are active (sequential rehydration gap)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const fanOutRunId = 'fan-out-run-uuid';
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({
        id: fanOutRunId,
        node_id: 'fan-out-node',
        block_type: 'fan_out',
        status: 'completed',
      }),
      makeDbNodeRun({
        node_id: 'body-start-task',
        status: 'completed',
        parent_fan_out_node_run_id: fanOutRunId,
      }),
      makeDbNodeRun({
        node_id: 'body-agent',
        status: 'running',
        parent_fan_out_node_run_id: fanOutRunId,
      }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const fanOut = getNodeState('flow-1', 'fan-out-node');
    expect(fanOut?.status).toBe('running');
    const body = getNodeState('flow-1', 'body-agent');
    expect(body?.status).toBe('running');
  });

  it('rehydrateFromRun: unrelated node with high attempt_number does not inflate fan_out iteration (graph-scoped body)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 10, currentIndex: 0 } },
        }),
        makeDbNodeRun({
          node_id: 'other-branch',
          status: 'completed',
          block_type: 'agent',
          attempt_number: 99,
        }),
        makeDbNodeRun({
          node_id: 'body-start',
          status: 'completed',
          block_type: 'start_task',
          attempt_number: 4,
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 4,
        }),
      ],
      graphFanOutChain('fo-node', ['body-start', 'body-agent']),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'fo-node')?.loopIteration).toBe(3);
    expect(getNodeState('flow-1', 'body-agent')?.loopIteration).toBe(3);
    expect(getNodeState('flow-1', 'other-branch')?.loopIteration).toBeUndefined();
  });

  it('rehydrateFromRun derives iteration from attempt_number + fan_out node_output (DB-driven)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 10, currentIndex: 0 } },
        }),
        makeDbNodeRun({
          node_id: 'body-start',
          status: 'completed',
          block_type: 'start_task',
          attempt_number: 4,
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 4,
        }),
      ],
      graphFanOutChain('fo-node', ['body-start', 'body-agent']),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const foState = getNodeState('flow-1', 'fo-node');
    expect(foState?.status).toBe('running');
    expect(foState?.loopIteration).toBe(3);
    expect(foState?.loopTotalCount).toBe(10);

    const startState = getNodeState('flow-1', 'body-start');
    expect(startState?.status).toBe('completed');
    expect(startState?.loopIteration).toBe(3);
    expect(startState?.loopTotalCount).toBe(10);

    const agentState = getNodeState('flow-1', 'body-agent');
    expect(agentState?.status).toBe('running');
    expect(agentState?.loopIteration).toBe(3);
    expect(agentState?.loopTotalCount).toBe(10);

    expect(getFlowLoopProgress('flow-1')).toEqual({ loopIteration: 3, loopTotalCount: 10 });
  });

  it('rehydrateFromRun: sequential DB iteration skipped when fan_out output has no totalCount', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: null,
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 3,
        }),
      ],
      graphFanOutChain('fo-node', ['body-agent']),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const agent = getNodeState('flow-1', 'body-agent');
    expect(agent?.status).toBe('running');
    expect(agent?.loopIteration).toBeUndefined();
    expect(agent?.loopTotalCount).toBeUndefined();
  });

  it('rehydrateFromRun: sequential fan-out does not propagate loop badge to pre-loop nodes', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'trigger',
          status: 'skipped',
          block_type: 'manual_trigger',
          attempt_number: 1,
        }),
        makeDbNodeRun({
          node_id: 'fetch-prs',
          status: 'completed',
          block_type: 'fetch-github-prs',
          attempt_number: 1,
        }),
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 10 } },
        }),
        makeDbNodeRun({
          node_id: 'body-start',
          status: 'completed',
          block_type: 'start_task',
          attempt_number: 3,
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 3,
        }),
      ],
      graphTriggerFetchFanOutBody(),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'trigger')?.loopIteration).toBeUndefined();
    expect(getNodeState('flow-1', 'fetch-prs')?.loopIteration).toBeUndefined();

    const fo = getNodeState('flow-1', 'fo-node');
    expect(fo?.loopIteration).toBe(2);
    expect(fo?.loopTotalCount).toBe(10);

    expect(getNodeState('flow-1', 'body-start')?.loopIteration).toBe(2);
    expect(getNodeState('flow-1', 'body-agent')?.loopIteration).toBe(2);
  });

  it('rehydrateFromRun: iteration 1 — fan_out gets badge, body nodes do not (live events fill badges)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 10 } },
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 1,
        }),
      ],
      graphFanOutChain('fo-node', ['body-agent']),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const fo = getNodeState('flow-1', 'fo-node');
    expect(fo?.loopIteration).toBe(0);
    expect(fo?.loopTotalCount).toBe(10);

    const agent = getNodeState('flow-1', 'body-agent');
    expect(agent?.loopIteration).toBeUndefined();
    expect(agent?.loopTotalCount).toBeUndefined();
  });

  it('viewRunOnCanvas: sequential fan-out does not badge pre-loop nodes (same merge as rehydrate)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes(
        [
          makeDbNodeRun({
            node_id: 'trigger',
            status: 'skipped',
            block_type: 'manual_trigger',
            attempt_number: 1,
          }),
          makeDbNodeRun({
            node_id: 'fetch-prs',
            status: 'completed',
            block_type: 'fetch-github-prs',
            attempt_number: 1,
          }),
          makeDbNodeRun({
            node_id: 'fo-node',
            status: 'completed',
            block_type: 'fan_out',
            node_output: { outputs: { totalCount: 10 } },
          }),
          makeDbNodeRun({
            node_id: 'body-start',
            status: 'completed',
            block_type: 'start_task',
            attempt_number: 3,
          }),
          makeDbNodeRun({
            node_id: 'body-agent',
            status: 'running',
            block_type: 'agent',
            attempt_number: 3,
          }),
        ],
        graphTriggerFetchFanOutBody(),
      ),
      id: 'run-hist-view',
    };

    act(() => {
      result.current.viewRunOnCanvas(run);
    });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-hist-view',
      isLive: false,
      isHistoricalInspection: true,
    });
    expect(getNodeState('flow-1', 'trigger')?.loopIteration).toBeUndefined();
    expect(getNodeState('flow-1', 'fetch-prs')?.loopIteration).toBeUndefined();
    expect(getNodeState('flow-1', 'fo-node')?.loopIteration).toBe(2);
    expect(getNodeState('flow-1', 'body-start')?.loopIteration).toBe(2);
    expect(getNodeState('flow-1', 'body-agent')?.loopIteration).toBe(2);
  });

  it('rehydrateFromRun: only body nodes with attempt_number >= maxAttempt get loop chip (in-iteration attempt desync)', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fo-node',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 10 } },
        }),
        makeDbNodeRun({
          node_id: 'body-start',
          status: 'completed',
          block_type: 'start_task',
          attempt_number: 3,
        }),
        makeDbNodeRun({
          node_id: 'body-agent',
          status: 'running',
          block_type: 'agent',
          attempt_number: 4,
        }),
      ],
      graphFanOutChain('fo-node', ['body-start', 'body-agent']),
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'fo-node')?.loopIteration).toBe(3);
    expect(getNodeState('flow-1', 'body-agent')?.loopIteration).toBe(3);
    expect(getNodeState('flow-1', 'body-start')?.loopIteration).toBeUndefined();
  });

  it('rehydrateFromRun: two fan_out nodes get distinct totalCount and same iteration index', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const twoFanOutGraph: FlowGraph = {
      nodes: [
        { id: 'fan-out-a', blockType: 'fan_out' },
        { id: 'fan-out-b', blockType: 'fan_out' },
        { id: 'body-a', blockType: 'agent', parentId: 'fan-out-a' },
        { id: 'body-b', blockType: 'agent', parentId: 'fan-out-b' },
        { id: 'after-a', blockType: 'agent' },
        { id: 'after-b', blockType: 'agent' },
      ],
      edges: [
        { id: 'ea', source: 'fan-out-a', target: 'body-a' },
        { id: 'eb', source: 'fan-out-b', target: 'body-b' },
        { id: 'ea-after', source: 'body-a', target: 'after-a' },
        { id: 'eb-after', source: 'body-b', target: 'after-b' },
      ],
    };
    const run = makeRunningRunWithNodes(
      [
        makeDbNodeRun({
          node_id: 'fan-out-a',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 29 } },
        }),
        makeDbNodeRun({
          node_id: 'fan-out-b',
          status: 'completed',
          block_type: 'fan_out',
          node_output: { outputs: { totalCount: 5 } },
        }),
        makeDbNodeRun({
          node_id: 'body-a',
          status: 'running',
          block_type: 'agent',
          attempt_number: 3,
        }),
        makeDbNodeRun({
          node_id: 'body-b',
          status: 'running',
          block_type: 'agent',
          attempt_number: 3,
        }),
      ],
      twoFanOutGraph,
    );

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    const a = getNodeState('flow-1', 'fan-out-a');
    const b = getNodeState('flow-1', 'fan-out-b');
    expect(a?.loopIteration).toBe(2);
    expect(a?.loopTotalCount).toBe(29);
    expect(b?.loopIteration).toBe(2);
    expect(b?.loopTotalCount).toBe(5);

    expect(getNodeState('flow-1', 'body-a')?.loopIteration).toBe(2);
    expect(getNodeState('flow-1', 'body-a')?.loopTotalCount).toBe(29);
    expect(getNodeState('flow-1', 'body-b')?.loopIteration).toBe(2);
    expect(getNodeState('flow-1', 'body-b')?.loopTotalCount).toBe(5);
  });

  it('rehydrateFromRun merges fan-out lanes: all completed rows collapse to completed', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'fan-node', status: 'completed', lane_index: 0 }),
      makeDbNodeRun({ node_id: 'fan-node', status: 'completed', lane_index: 1 }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'fan-node')?.status).toBe('completed');
  });

  it('rehydrateFromRun merges fan-out lanes: any failed row wins over completed', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'fan-node', status: 'completed', lane_index: 0 }),
      makeDbNodeRun({ node_id: 'fan-node', status: 'failed', lane_index: 1 }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'fan-node')?.status).toBe('failed');
  });

  it('rehydrateFromRun omits overlay for node_id with only pending lane rows', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'only-pending', status: 'pending', lane_index: 0 }),
      makeDbNodeRun({ node_id: 'done', status: 'completed', lane_index: null }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'only-pending')).toBeNull();
    expect(getNodeState('flow-1', 'done')?.status).toBe('completed');
  });

  it('rehydrateFromRun treats mixed pending and completed lanes as still running', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = makeRunningRunWithNodes([
      makeDbNodeRun({ node_id: 'mixed', status: 'completed', lane_index: 0 }),
      makeDbNodeRun({ node_id: 'mixed', status: 'pending', lane_index: 1 }),
    ]);

    act(() => {
      result.current.rehydrateFromRun(run);
    });

    expect(getNodeState('flow-1', 'mixed')?.status).toBe('running');
  });

  it('viewRunOnCanvas paints a completed run with historical inspection flag', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'h-a', status: 'completed' })]),
      id: 'run-hist-1',
      status: 'completed' as const,
    };

    act(() => {
      result.current.viewRunOnCanvas(run);
    });

    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-hist-1',
      isLive: false,
      isHistoricalInspection: true,
    });
    expect(getNodeState('flow-1', 'h-a')?.status).toBe('completed');
  });

  it('viewRunOnCanvas is a no-op while a live run is active', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-live' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-live',
      nodeId: 'live-n',
      blockType: 'agent',
    });

    const histRun = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'h-b', status: 'failed' })]),
      id: 'run-hist-2',
      status: 'failed' as const,
    };

    act(() => {
      result.current.viewRunOnCanvas(histRun);
    });

    expect(getFlowExecState('flow-1')?.flowRunId).toBe('run-live');
    expect(getNodeState('flow-1', 'live-n')?.status).toBe('running');
    expect(getNodeState('flow-1', 'h-b')).toBeNull();
  });

  it('viewRunOnCanvas is a no-op when the same historical run is applied twice', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'h-c', status: 'failed' })]),
      id: 'run-hist-3',
      status: 'failed' as const,
    };

    act(() => {
      result.current.viewRunOnCanvas(run);
    });
    act(() => {
      result.current.viewRunOnCanvas(run);
    });

    expect(getFlowExecState('flow-1')?.flowRunId).toBe('run-hist-3');
    expect(getNodeState('flow-1', 'h-c')?.status).toBe('failed');
  });

  it('run_started clears historical inspection overlay and begins a new live run', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const histRun = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'hist-node', status: 'failed' })]),
      id: 'run-old',
      status: 'failed' as const,
    };
    act(() => {
      result.current.viewRunOnCanvas(histRun);
    });
    expect(getFlowExecState('flow-1')?.isHistoricalInspection).toBe(true);
    expect(getNodeState('flow-1', 'hist-node')?.status).toBe('failed');

    dispatch({ eventType: 'run_started', flowRunId: 'run-new' });
    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-new',
      isLive: true,
      isHistoricalInspection: false,
    });
    expect(getNodeState('flow-1', 'hist-node')).toBeNull();
  });

  it('viewRunOnCanvas replaces a prior historical overlay when switching runs', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const runA = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'sw-a', status: 'completed' })]),
      id: 'run-switch-a',
      status: 'completed' as const,
    };
    const runB = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'sw-b', status: 'failed' })]),
      id: 'run-switch-b',
      status: 'failed' as const,
    };
    act(() => {
      result.current.viewRunOnCanvas(runA);
    });
    act(() => {
      result.current.viewRunOnCanvas(runB);
    });
    expect(getFlowExecState('flow-1')?.flowRunId).toBe('run-switch-b');
    expect(getFlowExecState('flow-1')?.isHistoricalInspection).toBe(true);
    expect(getNodeState('flow-1', 'sw-a')).toBeNull();
    expect(getNodeState('flow-1', 'sw-b')?.status).toBe('failed');
  });

  it('viewRunOnCanvas works after clearOverlay repopulates overlay from empty state', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const run = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'after-clear', status: 'completed' })]),
      id: 'run-after-clear',
      status: 'completed' as const,
    };
    act(() => {
      result.current.viewRunOnCanvas(run);
    });
    expect(getNodeState('flow-1', 'after-clear')?.status).toBe('completed');

    act(() => {
      result.current.clearOverlay();
    });
    expect(getFlowExecState('flow-1')).toBeUndefined();
    expect(getNodeState('flow-1', 'after-clear')).toBeNull();

    act(() => {
      result.current.viewRunOnCanvas(run);
    });
    expect(getFlowExecState('flow-1')?.flowRunId).toBe('run-after-clear');
    expect(getFlowExecState('flow-1')?.isHistoricalInspection).toBe(true);
    expect(getNodeState('flow-1', 'after-clear')?.status).toBe('completed');
  });

  it('viewRunOnCanvas can republish historical inspection after socket terminal state for the same run id', () => {
    const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-same' });
    dispatch({
      eventType: 'node_started',
      flowRunId: 'run-same',
      nodeId: 'n1',
      blockType: 'agent',
    });
    dispatch({
      eventType: 'run_completed',
      flowRunId: 'run-same',
      runStatus: 'completed',
      nodeStatuses: { n1: { status: 'completed' } },
    });
    expect(getFlowExecState('flow-1')?.isHistoricalInspection).toBe(false);

    const runDetail = {
      ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'n1', status: 'completed' })]),
      id: 'run-same',
      status: 'completed' as const,
    };
    act(() => {
      result.current.viewRunOnCanvas(runDetail);
    });
    expect(getFlowExecState('flow-1')).toEqual({
      flowRunId: 'run-same',
      isLive: false,
      isHistoricalInspection: true,
    });
    expect(getNodeState('flow-1', 'n1')?.status).toBe('completed');
  });

  it('unmounting one instance does not clear overlay when another instance shares the same flowId', () => {
    const { unmount: unmountFirst } = renderHook(() => useFlowCanvasExecution('flow-1'));
    const { unmount: unmountSecond } = renderHook(() => useFlowCanvasExecution('flow-1'));
    expect(executionEventListeners).toHaveLength(2);

    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'node_started', nodeId: 'node-a', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-a')?.status).toBe('running');

    unmountFirst();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(executionEventListeners).toHaveLength(1);

    expect(getNodeState('flow-1', 'node-a')?.status).toBe('running');
    expect(getFlowExecState('flow-1')?.isLive).toBe(true);

    unmountSecond();
    expect(executionEventListeners).toHaveLength(0);
    expect(getNodeState('flow-1', 'node-a')).toBeNull();
    expect(getFlowExecState('flow-1')).toBeUndefined();
  });

  it('clearOverlay from one instance clears overlay for all instances sharing the same flowId', () => {
    const { result: resultA } = renderHook(() => useFlowCanvasExecution('flow-1'));
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'node_started', nodeId: 'node-h', blockType: 'agent' });
    expect(getNodeState('flow-1', 'node-h')?.status).toBe('running');

    act(() => {
      resultA.current.clearOverlay();
    });

    expect(getNodeState('flow-1', 'node-h')).toBeNull();
    expect(getFlowExecState('flow-1')).toBeUndefined();
  });

  it('run_failed with nodeStatuses reconciles a stuck running node', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'node_started', nodeId: 'node-z', blockType: 'agent' });
    dispatch({
      eventType: 'run_failed',
      runStatus: 'failed',
      nodeStatuses: { 'node-z': { status: 'failed' } },
    });
    expect(getNodeState('flow-1', 'node-z')?.status).toBe('failed');
    expect(getFlowExecState('flow-1')?.isLive).toBe(false);
  });

  it('run_cancelled with nodeStatuses reconciles multiple nodes', () => {
    renderHook(() => useFlowCanvasExecution('flow-1'));
    dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
    dispatch({ eventType: 'node_started', nodeId: 'node-p', blockType: 'agent' });
    dispatch({ eventType: 'node_started', nodeId: 'node-q', blockType: 'condition' });
    dispatch({
      eventType: 'run_cancelled',
      runStatus: 'cancelled',
      nodeStatuses: {
        'node-p': { status: 'completed' },
        'node-q': { status: 'skipped' },
      },
    });
    expect(getNodeState('flow-1', 'node-p')?.status).toBe('completed');
    expect(getNodeState('flow-1', 'node-q')?.status).toBe('skipped');
    expect(getFlowExecState('flow-1')?.isLive).toBe(false);
  });

  describe('park states (awaiting_input / blocked) paint as themselves, not running', () => {
    it('run_paused paints the parked node from nodeStatuses and keeps the run live', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'ask',
        blockType: 'agent',
      });
      dispatch({
        eventType: 'run_paused',
        flowRunId: 'run-1',
        runStatus: 'paused',
        nodeStatuses: { ask: { status: 'awaiting_input' } },
      });
      expect(getNodeState('flow-1', 'ask')?.status).toBe('awaiting_input');
      expect(getFlowExecState('flow-1')?.isLive).toBe(true);
    });

    it('run_paused paints a blocked node', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'run_paused',
        flowRunId: 'run-1',
        runStatus: 'paused',
        nodeStatuses: { stuck: { status: 'blocked' } },
      });
      expect(getNodeState('flow-1', 'stuck')?.status).toBe('blocked');
    });

    it('ignores run_paused for a stale flowRunId after a newer run_started', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-2' });
      dispatch({
        eventType: 'run_paused',
        flowRunId: 'run-1',
        runStatus: 'paused',
        nodeStatuses: { ask: { status: 'awaiting_input' } },
      });
      expect(getNodeState('flow-1', 'ask')).toBeNull();
    });

    it('a resumed node (node_started) repaints running over a prior park', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({
        eventType: 'run_paused',
        flowRunId: 'run-1',
        runStatus: 'paused',
        nodeStatuses: { ask: { status: 'awaiting_input' } },
      });
      dispatch({
        eventType: 'node_started',
        flowRunId: 'run-1',
        nodeId: 'ask',
        blockType: 'agent',
      });
      expect(getNodeState('flow-1', 'ask')?.status).toBe('running');
    });

    it('rehydrateFromRun paints a parked node_run as awaiting_input (not running)', () => {
      const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
      const run = {
        ...makeRunningRunWithNodes([
          makeDbNodeRun({ node_id: 'done-node', status: 'completed' }),
          makeDbNodeRun({ node_id: 'ask', status: 'awaiting_input' }),
        ]),
        status: 'paused',
      };
      act(() => {
        result.current.rehydrateFromRun(run);
      });
      expect(getNodeState('flow-1', 'done-node')?.status).toBe('completed');
      expect(getNodeState('flow-1', 'ask')?.status).toBe('awaiting_input');
    });

    it('rehydrateFromRun paints a blocked node_run as blocked', () => {
      const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
      const run = {
        ...makeRunningRunWithNodes([makeDbNodeRun({ node_id: 'stuck', status: 'blocked' })]),
        status: 'paused',
      };
      act(() => {
        result.current.rehydrateFromRun(run);
      });
      expect(getNodeState('flow-1', 'stuck')?.status).toBe('blocked');
    });

    it('a running lane outranks a parked lane on the same node (fan-out collapse)', () => {
      const { result } = renderHook(() => useFlowCanvasExecution('flow-1'));
      const run = makeRunningRunWithNodes([
        makeDbNodeRun({ node_id: 'body', status: 'awaiting_input', lane_index: 0 }),
        makeDbNodeRun({ node_id: 'body', status: 'running', lane_index: 1 }),
      ]);
      act(() => {
        result.current.rehydrateFromRun(run);
      });
      expect(getNodeState('flow-1', 'body')?.status).toBe('running');
    });
  });

  describe('timer management (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('node_completed defers transition until the min-display window elapses', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'node_started', nodeId: 'node-timer-1', blockType: 'agent' });
      dispatch({ eventType: 'node_completed', nodeId: 'node-timer-1', blockType: 'agent' });

      // Still running — min-display window has not elapsed yet
      expect(getNodeState('flow-1', 'node-timer-1')?.status).toBe('running');

      // Advance past the 300ms window
      act(() => {
        vi.advanceTimersByTime(350);
      });
      expect(getNodeState('flow-1', 'node-timer-1')?.status).toBe('completed');
    });

    it('run_started cancels a pending min-display timer so it cannot fire after the run clears', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'node_started', nodeId: 'node-timer-2', blockType: 'agent' });
      // Complete before window expires — queues a deferred timer
      dispatch({ eventType: 'node_completed', nodeId: 'node-timer-2', blockType: 'agent' });
      expect(getNodeState('flow-1', 'node-timer-2')?.status).toBe('running');

      // New run begins — should cancel the timer and clear atoms
      dispatch({ eventType: 'run_started', flowRunId: 'run-2' });
      expect(getNodeState('flow-1', 'node-timer-2')).toBeNull();

      // Advancing past the original window must NOT resurrect the node atom
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(getNodeState('flow-1', 'node-timer-2')).toBeNull();
    });

    it('run_completed cancels a pending min-display timer and immediately applies nodeStatuses', () => {
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({ eventType: 'node_started', nodeId: 'node-timer-3', blockType: 'agent' });
      // Complete before window expires — timer is pending
      dispatch({ eventType: 'node_completed', nodeId: 'node-timer-3', blockType: 'agent' });
      expect(getNodeState('flow-1', 'node-timer-3')?.status).toBe('running');

      // Terminal event with nodeStatuses — should cancel the timer and apply immediately
      dispatch({
        eventType: 'run_completed',
        runStatus: 'completed',
        nodeStatuses: { 'node-timer-3': { status: 'completed' } },
      });
      expect(getNodeState('flow-1', 'node-timer-3')?.status).toBe('completed');

      // Advancing timers must not cause further state changes
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(getNodeState('flow-1', 'node-timer-3')?.status).toBe('completed');
    });

    it('flowId change cancels timers and clears atoms for the old flow', () => {
      const { rerender } = renderHook(({ id }: { id: string }) => useFlowCanvasExecution(id), {
        initialProps: { id: 'flow-1' },
      });

      dispatch({ eventType: 'node_started', nodeId: 'node-timer-4', blockType: 'agent' });
      // Complete while still in min-display window — pending timer
      dispatch({ eventType: 'node_completed', nodeId: 'node-timer-4', blockType: 'agent' });
      expect(getNodeState('flow-1', 'node-timer-4')?.status).toBe('running');

      // Switch to flow-2 — cleanup for flow-1 must run
      act(() => {
        rerender({ id: 'flow-2' });
      });
      expect(getNodeState('flow-1', 'node-timer-4')).toBeNull();

      // Old timer must not fire and restore the cleared atom
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(getNodeState('flow-1', 'node-timer-4')).toBeNull();
    });

    it('clearOverlay from one instance cancels a deferred timer registered via another instance (same flowId)', () => {
      const { result: resultA } = renderHook(() => useFlowCanvasExecution('flow-1'));
      renderHook(() => useFlowCanvasExecution('flow-1'));
      dispatch({ eventType: 'run_started', flowRunId: 'run-1' });
      dispatch({ eventType: 'node_started', nodeId: 'node-timer-5', blockType: 'agent' });
      dispatch({ eventType: 'node_completed', nodeId: 'node-timer-5', blockType: 'agent' });
      expect(getNodeState('flow-1', 'node-timer-5')?.status).toBe('running');

      act(() => {
        resultA.current.clearOverlay();
      });
      expect(getNodeState('flow-1', 'node-timer-5')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(getNodeState('flow-1', 'node-timer-5')).toBeNull();
    });
  });
});
