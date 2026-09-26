import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowExecutionEvent } from '../../../../../shared/types/flow';
import {
  createNodeBurstRefreshScheduler,
  handleFlowExecutionSocketEvent,
  NODE_BURST_DEBOUNCE_MS,
} from './flow-run-history-socket-refresh';

const baseEvent = (partial: Partial<FlowExecutionEvent>): FlowExecutionEvent => ({
  eventType: 'node_completed',
  flowId: 'flow-1',
  flowRunId: 'run-1',
  flowName: 'F',
  runStatus: 'running',
  ...partial,
});

const makeInvalidateFns = () => ({
  invalidateListRuns: vi.fn(),
  invalidateGetRun: vi.fn(),
  invalidateListBatches: vi.fn(),
  invalidateListBatchRuns: vi.fn(),
  invalidateListBatchStages: vi.fn(),
});

describe('createNodeBurstRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple node schedules into one invalidate after delay', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => 'run-1',
      ...fns,
    });

    scheduler.schedule('run-1');
    scheduler.schedule('run-1');
    scheduler.schedule('run-1');

    expect(fns.invalidateListRuns).not.toHaveBeenCalled();

    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);

    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).toHaveBeenCalledWith('run-1');
  });

  it('does NOT call invalidateListBatchStages during node burst (only on terminal events)', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => null,
      ...fns,
    });

    scheduler.schedule('run-1');
    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);

    expect(fns.invalidateListBatchStages).not.toHaveBeenCalled();
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate getRun when expanded run does not match burst run', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => 'run-other',
      ...fns,
    });

    scheduler.schedule('run-1');
    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);

    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).not.toHaveBeenCalled();
  });

  it('flush clears pending timer without firing', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => null,
      ...fns,
    });

    scheduler.schedule('run-1');
    scheduler.flush();
    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);

    expect(fns.invalidateListRuns).not.toHaveBeenCalled();
  });
});

describe('handleFlowExecutionSocketEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores events for a different flow', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => null,
      ...fns,
    });

    handleFlowExecutionSocketEvent(baseEvent({ flowId: 'other', eventType: 'run_completed' }), {
      panelFlowId: 'flow-1',
      expandedRunId: null,
      scheduler,
      ...fns,
    });

    expect(fns.invalidateListRuns).not.toHaveBeenCalled();
    expect(fns.invalidateListBatches).not.toHaveBeenCalled();
    expect(fns.invalidateListBatchRuns).not.toHaveBeenCalled();
    expect(fns.invalidateListBatchStages).not.toHaveBeenCalled();
  });

  it('terminal events invalidate immediately including batch stages, and flush pending debounce', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => 'run-1',
      ...fns,
    });

    handleFlowExecutionSocketEvent(baseEvent({ eventType: 'node_completed' }), {
      panelFlowId: 'flow-1',
      expandedRunId: 'run-1',
      scheduler,
      ...fns,
    });

    vi.advanceTimersByTime(200);

    handleFlowExecutionSocketEvent(baseEvent({ eventType: 'run_completed', flowRunId: 'run-1' }), {
      panelFlowId: 'flow-1',
      expandedRunId: 'run-1',
      scheduler,
      ...fns,
    });

    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchStages).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);
    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchStages).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).toHaveBeenCalledTimes(1);
  });

  it('node-level events do NOT call invalidateListBatchStages', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => null,
      ...fns,
    });

    handleFlowExecutionSocketEvent(baseEvent({ eventType: 'node_started' }), {
      panelFlowId: 'flow-1',
      expandedRunId: null,
      scheduler,
      ...fns,
    });

    // Before debounce fires — nothing called yet
    expect(fns.invalidateListBatchStages).not.toHaveBeenCalled();

    vi.advanceTimersByTime(NODE_BURST_DEBOUNCE_MS);

    // After debounce: batch runs is invalidated but NOT batch stages
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchStages).not.toHaveBeenCalled();
  });

  it('terminal getRun invalidate only when expanded matches flowRunId', () => {
    const fns = makeInvalidateFns();
    const scheduler = createNodeBurstRefreshScheduler({
      delayMs: NODE_BURST_DEBOUNCE_MS,
      getExpandedRunId: () => 'run-a',
      ...fns,
    });

    handleFlowExecutionSocketEvent(baseEvent({ eventType: 'run_failed', flowRunId: 'run-b' }), {
      panelFlowId: 'flow-1',
      expandedRunId: 'run-a',
      scheduler,
      ...fns,
    });

    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchStages).toHaveBeenCalledTimes(1);
    expect(fns.invalidateGetRun).not.toHaveBeenCalled();
  });
});

describe('handleFlowExecutionSocketEvent — batch_completed', () => {
  it('treats batch_completed as terminal: flush + full invalidate, no getRun (no single run)', () => {
    const fns = makeInvalidateFns();
    const scheduler = { flush: vi.fn(), schedule: vi.fn() };
    handleFlowExecutionSocketEvent(
      baseEvent({ eventType: 'batch_completed', flowRunId: undefined, batchId: 'b1' }),
      {
        panelFlowId: 'flow-1',
        expandedRunId: 'run-1',
        scheduler: scheduler as never,
        ...fns,
      },
    );
    expect(scheduler.flush).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatches).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchRuns).toHaveBeenCalledTimes(1);
    expect(fns.invalidateListBatchStages).toHaveBeenCalledTimes(1);
    // A batch has no single run — the expanded-run refresh must not fire on
    // an undefined flowRunId (nor crash on it).
    expect(fns.invalidateGetRun).not.toHaveBeenCalled();
  });

  it('a node event without a flowRunId is ignored instead of scheduling undefined', () => {
    const fns = makeInvalidateFns();
    const scheduler = { flush: vi.fn(), schedule: vi.fn() };
    handleFlowExecutionSocketEvent(
      baseEvent({ eventType: 'node_completed', flowRunId: undefined }),
      {
        panelFlowId: 'flow-1',
        expandedRunId: null,
        scheduler: scheduler as never,
        ...fns,
      },
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});
