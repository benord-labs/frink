import type { MobileFlow, MobileResponses } from '@frink/shared/types/remote/mobile';
import { flowMenu } from './flow-list';

/** The two requests the list sends, already addressed to one computer. */
export type FlowRequests = {
  start: (flowId: string, requestId: string) => Promise<MobileResponses['startFlow']>;
  setEnabled: (flowId: string, enabled: boolean) => Promise<MobileResponses['setFlowEnabled']>;
};
/** Says why an action failed and offers to send the very same request again. */
export type RetryPrompt = (title: string, message: string, retry: () => void) => void;

/**
 * Flow actions started from the list. One runs at a time, so a double tap sends once, and each
 * tap of Run now gets its own request id that Try again reuses, so the computer starts one run.
 */
export function createFlowActions(send: FlowRequests, prompt: RetryPrompt, newId: () => string) {
  let busy = false;
  async function perform<T>(title: string, task: () => Promise<T>, done: (value: T) => void) {
    if (busy) return;
    busy = true;
    let value: T;
    try {
      value = await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again in a moment.';
      prompt(title, message, () => void perform(title, task, done));
      return;
    } finally {
      busy = false;
    }
    done(value);
  }
  return {
    start(flow: MobileFlow, onStarted: (runId: string) => void) {
      const requestId = newId();
      return perform(
        `Couldn’t start ${flow.name}`,
        () => send.start(flow.id, requestId),
        (run) => onStarted(run.id),
      );
    },
    setEnabled(flow: MobileFlow, enabled: boolean, onDone: () => void) {
      return perform(
        `Couldn’t turn ${flow.name} ${enabled ? 'on' : 'off'}`,
        () => send.setEnabled(flow.id, enabled),
        onDone,
      );
    },
  };
}

type FlowActions = ReturnType<typeof createFlowActions>;

/** One Flow's long-press sheet: its buttons, Cancel last, and what picking each one does. */
export function flowSheet(
  flow: MobileFlow,
  actions: FlowActions,
  { openRun, refresh }: { openRun: (runId: string) => void; refresh: () => void },
) {
  const items = flowMenu(flow);
  return {
    options: [...items.map((item) => item.label), 'Cancel'],
    cancelButtonIndex: items.length,
    pick(index: number) {
      const item = items.at(index);
      if (!item) return;
      if (item.id === 'open') return openRun(item.runId);
      if (item.id === 'toggle') return void actions.setEnabled(flow, !flow.enabled, refresh);
      void actions.start(flow, (runId) => {
        refresh();
        openRun(runId);
      });
    },
  };
}
