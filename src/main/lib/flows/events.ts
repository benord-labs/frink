/**
 * In-process flow execution event bus.
 *
 * Replaces socket.io `flow:execution-event` from the cloud engine. Emitter is
 * single-process; renderers consume via tRPC subscription (`flows.onExecutionEvent`).
 *
 * setMaxListeners(0) — concurrent flow runs each register their own listener; the
 * Node default of 10 trips when several runs subscribe at once.
 */

import { EventEmitter } from 'node:events';
import type { FlowExecutionEvent } from '../../../shared/types/flow';

class FlowEventBus extends EventEmitter {
  emitFlowEvent(event: FlowExecutionEvent): void {
    this.emit('flow-event', event);
  }
}

export const flowEventBus = new FlowEventBus();
flowEventBus.setMaxListeners(0);

export function subscribeFlowEvents(handler: (e: FlowExecutionEvent) => void): () => void {
  flowEventBus.on('flow-event', handler);
  return () => flowEventBus.off('flow-event', handler);
}
