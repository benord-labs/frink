import type { FlowExecutionEvent } from '../../../../../shared/types/flow';

export const NODE_BURST_DEBOUNCE_MS = 500;

function isTerminalFlowExecutionEvent(eventType: FlowExecutionEvent['eventType']): boolean {
  return (
    eventType === 'run_completed' ||
    eventType === 'run_failed' ||
    eventType === 'run_cancelled' ||
    eventType === 'run_started' ||
    eventType === 'run_paused' ||
    eventType === 'batch_completed'
  );
}

function isNodeLevelFlowExecutionEvent(eventType: FlowExecutionEvent['eventType']): boolean {
  return (
    eventType === 'node_started' ||
    eventType === 'node_completed' ||
    eventType === 'node_failed' ||
    eventType === 'node_skipped'
  );
}

type FlowRunHistoryInvalidateFns = {
  invalidateListRuns: () => void;
  invalidateGetRun: (runId: string) => void;
  invalidateListBatches: () => void;
  invalidateListBatchRuns: () => void;
  invalidateListBatchStages: () => void;
};

type CreateNodeBurstSchedulerParams = {
  delayMs: number;
  getExpandedRunId: () => string | null;
} & FlowRunHistoryInvalidateFns;

/**
 * Coalesces node_* socket bursts into a single listRuns + listBatches + listBatchRuns
 * (+ optional getRun) refresh.
 * NOTE: invalidateListBatchStages is intentionally NOT called here — stage status only
 * changes on terminal flow events, not node-level events.
 */
export function createNodeBurstRefreshScheduler(params: CreateNodeBurstSchedulerParams) {
  const {
    delayMs,
    getExpandedRunId,
    invalidateListRuns,
    invalidateGetRun,
    invalidateListBatches,
    invalidateListBatchRuns,
  } = params;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let nodeBurstRunId: string | null = null;

  const flush = () => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const schedule = (eventFlowRunId: string) => {
    nodeBurstRunId = eventFlowRunId;
    flush();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      invalidateListRuns();
      invalidateListBatches();
      invalidateListBatchRuns();
      const expandedRunId = getExpandedRunId();
      if (expandedRunId != null && expandedRunId === nodeBurstRunId) {
        invalidateGetRun(expandedRunId);
      }
    }, delayMs);
  };

  return { schedule, flush };
}

type HandleSocketEventContext = {
  panelFlowId: string;
  expandedRunId: string | null;
  scheduler: ReturnType<typeof createNodeBurstRefreshScheduler>;
} & FlowRunHistoryInvalidateFns;

export function handleFlowExecutionSocketEvent(
  event: FlowExecutionEvent,
  ctx: HandleSocketEventContext,
): void {
  if (event.flowId !== ctx.panelFlowId) return;

  if (isTerminalFlowExecutionEvent(event.eventType)) {
    ctx.scheduler.flush();
    ctx.invalidateListRuns();
    ctx.invalidateListBatches();
    ctx.invalidateListBatchRuns();
    ctx.invalidateListBatchStages();
    if (ctx.expandedRunId === event.flowRunId) {
      ctx.invalidateGetRun(ctx.expandedRunId);
    }
    return;
  }

  if (isNodeLevelFlowExecutionEvent(event.eventType) && event.flowRunId) {
    ctx.scheduler.schedule(event.flowRunId);
  }
}
