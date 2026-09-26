/**
 * Bridges the in-process `flowEventBus` (engine-emitted events) to the renderer
 * over the existing `socket:flow-execution-event` IPC channel.
 *
 * The renderer's `desktopApi.onSocketFlowExecutionEvent` listener (used by
 * FlowsList, FlowEditor, FlowLastRunBadge, FlowRunHistoryPanel) was originally
 * fed by socket.io receiving cloud events. After the local migration the
 * engine emits to flowEventBus directly; this module forwards each event to
 * every BrowserWindow so renderer code requires zero changes.
 *
 * Idempotent — calling startFlowEventBridge twice is a no-op (subscription
 * is captured at first call).
 */

import { BrowserWindow } from 'electron';
import { subscribeFlowEvents } from './events';

const IPC_CHANNEL = 'socket:flow-execution-event';

let unsubscribe: (() => void) | null = null;

export function startFlowEventBridge(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeFlowEvents((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC_CHANNEL, event);
      } catch {
        // window mid-close: webContents.send can throw between isDestroyed()
        // returning false and the IPC send. Swallow — flowEventBus emits
        // synchronously and any throw here would propagate into the engine
        // (advanceFlowRun) and corrupt the run with a spurious failure.
      }
    }
  });
}

export function stopFlowEventBridge(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
