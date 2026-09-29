import type { MobileFlow } from '../../../../src/shared/types/remote/mobile';
import type { Status } from '../../lib/status';
import { flowStatus } from '../Flows/flow-list';

const AUTOMATIC: Record<string, string> = {
  schedule_trigger: 'Runs on a schedule',
  webhook_trigger: 'Runs when its webhook is called',
  post_task_trigger: 'Runs after a task finishes',
};

/** What the Enabled switch controls, in words. A disabled Flow can't run at all, even by hand. */
export function enabledHint(flow: Pick<MobileFlow, 'enabled' | 'trigger'>): string {
  if (!flow.enabled) return 'Off. Turn it on to run it.';
  return AUTOMATIC[flow.trigger] ?? 'Runs when you start it';
}

/** Why "Run now" can't be pressed, or null when it can. A live run is offered instead of it. */
export function runNowBlocker(
  flow: Pick<MobileFlow, 'enabled'>,
  executionReady: boolean | undefined,
): string | null {
  if (executionReady === false) return 'Open Frink on your Mac to run Flows.';
  if (!flow.enabled) return 'Turn this Flow on to run it.';
  return null;
}

export type FlowAttention = { status: Status; title: string; subtitle: string; runId: string };

/** What a Flow in "Needs you" is waiting on, and which run to open to act on it. */
export function flowAttention(flow: MobileFlow): FlowAttention | null {
  const status = flowStatus(flow);
  // `status` comes from the live run when there is one, otherwise from the newest run.
  const runId = flow.status ? flow.latestRunId : (flow.lastRun?.id ?? null);
  if (!runId) return null;
  if (status.tone === 'attention')
    return { status, title: 'Waiting for you', subtitle: 'Open the run to decide', runId };
  if (status.tone === 'danger')
    return {
      status,
      title: 'Last run failed',
      subtitle: 'Open the run to see what went wrong',
      runId,
    };
  return null;
}
