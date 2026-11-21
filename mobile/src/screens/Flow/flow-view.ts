import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { isTerminal } from '../Run/run-view';

/** A parked run still owns this Flow's primary action. Never start over it. */
export function currentRunId(flow: MobileFlow): string | null {
  return flow.status && !isTerminal(flow.status) ? flow.latestRunId : null;
}

const AUTOMATIC: Record<string, string> = {
  schedule_trigger: 'Runs on a schedule',
  webhook_trigger: 'Runs when its webhook is called',
  post_task_trigger: 'Runs after a task finishes',
};

/** How a Flow starts, in words. */
export function triggerWords(trigger: string): string {
  return AUTOMATIC[trigger] ?? 'Runs when you start it';
}

/** Why "Run now" can't be pressed, or null when it can. Any unfinished run blocks a second one. */
export function runNowBlocker(
  flow: Pick<MobileFlow, 'enabled' | 'status'>,
  executionReady: boolean | undefined,
): string | null {
  if (flow.status && !isTerminal(flow.status)) return 'Refresh to find the current run.';
  if (executionReady === false) return 'Open Frink on your Mac to run Flows.';
  if (!flow.enabled) return 'Turn this Flow on to run it.';
  return null;
}

/** Shows the switch at its new position while saving; it moves back only if the computer refused. */
export async function saveEnabled(
  value: boolean,
  {
    show,
    send,
    saved,
  }: {
    show: (value: boolean | null) => void;
    send: (value: boolean) => Promise<boolean>;
    saved: () => void;
  },
) {
  show(value);
  if (await send(value)) saved();
  else show(null);
}
