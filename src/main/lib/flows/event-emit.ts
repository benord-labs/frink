/**
 * Helpers that build + emit FlowExecutionEvent payloads onto the in-process
 * event bus. Keeps event shape construction in one spot so engine.ts stays
 * focused on lifecycle logic.
 */

import type { FlowExecutionEvent } from '../../../shared/types/flow';
import { flowEventBus } from './events';

/** `batchId` marks a batch-member run — carried on its events so the renderer
 *  can keep members individually silent (only batch_completed sounds). */
type FlowMeta = { flowId: string; flowName: string; batchId?: string };

export function emitRunStarted(meta: FlowMeta, flowRunId: string): void {
  flowEventBus.emitFlowEvent({
    eventType: 'run_started',
    flowId: meta.flowId,
    flowRunId,
    flowName: meta.flowName,
    runStatus: 'running',
    batchId: meta.batchId,
  });
}

export function emitRunTerminal(
  meta: FlowMeta,
  flowRunId: string,
  status: 'completed' | 'failed' | 'cancelled',
  extras: { durationMs?: number; summary?: string } = {},
): void {
  const eventType: FlowExecutionEvent['eventType'] =
    status === 'completed' ? 'run_completed' : status === 'failed' ? 'run_failed' : 'run_cancelled';
  flowEventBus.emitFlowEvent({
    eventType,
    flowId: meta.flowId,
    flowRunId,
    flowName: meta.flowName,
    runStatus: status,
    batchId: meta.batchId,
    durationMs: extras.durationMs,
    summary: extras.summary,
  });
}

export function emitNodeStarted(
  meta: FlowMeta,
  flowRunId: string,
  nodeId: string,
  blockType: string,
  nodeLabel?: string,
): void {
  flowEventBus.emitFlowEvent({
    eventType: 'node_started',
    flowId: meta.flowId,
    flowRunId,
    flowName: meta.flowName,
    runStatus: 'running',
    nodeId,
    blockType,
    nodeLabel,
  });
}

export function emitNodeTerminal(
  meta: FlowMeta,
  flowRunId: string,
  status: 'completed' | 'failed' | 'skipped',
  nodeId: string,
  blockType: string,
  durationMs?: number,
): void {
  const eventType: FlowExecutionEvent['eventType'] =
    status === 'completed'
      ? 'node_completed'
      : status === 'failed'
        ? 'node_failed'
        : 'node_skipped';
  flowEventBus.emitFlowEvent({
    eventType,
    flowId: meta.flowId,
    flowRunId,
    flowName: meta.flowName,
    runStatus: 'running',
    nodeId,
    blockType,
    durationMs,
  });
}

/**
 * `nodeStatuses` carries the parked node(s) (`awaiting_input`/`blocked`) so the canvas can paint
 * the wait state — without it a parked node keeps its last paint (usually `running`).
 */
export function emitRunPaused(
  meta: FlowMeta,
  flowRunId: string,
  nodeStatuses?: FlowExecutionEvent['nodeStatuses'],
  pauseKind?: FlowExecutionEvent['pauseKind'],
): void {
  flowEventBus.emitFlowEvent({
    eventType: 'run_paused',
    flowId: meta.flowId,
    flowRunId,
    flowName: meta.flowName,
    runStatus: 'paused',
    batchId: meta.batchId,
    nodeStatuses,
    pauseKind,
  });
}

/**
 * The whole batch reached terminal (transition-based: a rerun that re-opens
 * stages re-fires this on re-terminalization). No flowRunId — a batch has no
 * single run; `runStatus` carries the batch verdict.
 */
export function emitBatchCompleted(
  meta: Pick<FlowMeta, 'flowId' | 'flowName'>,
  batchId: string,
  verdict: 'completed' | 'failed',
): void {
  flowEventBus.emitFlowEvent({
    eventType: 'batch_completed',
    flowId: meta.flowId,
    flowName: meta.flowName,
    runStatus: verdict,
    batchId,
  });
}
