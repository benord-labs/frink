import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { runStatus, type Status } from '../../lib/status';
import { runNowBlocker, triggerWords } from '../Flow/flow-view';
import { isTerminal } from '../Run/run-view';

export type FlowGroups = { now: Array<{ flow: MobileFlow; runId: string }>; all: MobileFlow[] };
export type FlowMenuItem =
  | { id: 'run' | 'toggle'; label: string }
  | { id: 'open'; label: string; runId: string };

/** The live run's status, else the most recent run's: what the row reports. */
function shownStatus(flow: MobileFlow): string | null {
  return flow.status ?? flow.lastRun?.status ?? null;
}

export function flowStatus(flow: MobileFlow): Status {
  return runStatus(shownStatus(flow));
}

/** The run a row opens: the live one while there is one, else the last finished one. */
export function flowRunId(flow: MobileFlow): string | null {
  return flow.status ? flow.latestRunId : (flow.lastRun?.id ?? null);
}

export function matchingFlows(flows: MobileFlow[], query = ''): MobileFlow[] {
  const needle = query.trim().toLowerCase();
  return flows.filter((flow) => `${flow.name} ${flow.description}`.toLowerCase().includes(needle));
}

/** "Now" holds every unfinished run once, waits included; "All Flows" lists every Flow. */
export function groupFlows(flows: MobileFlow[]): FlowGroups {
  const now = new Map<string, MobileFlow>();
  for (const flow of flows) {
    const runId = flow.latestRunId;
    if (runId && flow.status && !isTerminal(flow.status) && !now.has(runId)) now.set(runId, flow);
  }
  return { now: [...now].map(([runId, flow]) => ({ flow, runId })), all: flows };
}

/** The one Queue link the Flows list shows; the Queue lists and counts what needs you. */
export function needsYouLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 needs you' : `${count} need you`;
}

/** A Flow row's second line: what it does, else how it starts. */
export function flowSubtitle(flow: Pick<MobileFlow, 'description' | 'trigger'>): string {
  return flow.description || triggerWords(flow.trigger);
}

/** The long-press actions, in the order the Flow page offers them. */
export function flowMenu(flow: MobileFlow): FlowMenuItem[] {
  const items: FlowMenuItem[] = [];
  const live = !!flow.status && !isTerminal(flow.status);
  if (!runNowBlocker(flow, undefined)) items.push({ id: 'run', label: 'Run now' });
  items.push({ id: 'toggle', label: flow.enabled ? 'Turn off' : 'Turn on' });
  const runId = flowRunId(flow);
  if (runId) items.push({ id: 'open', label: live ? 'View current run' : 'View last run', runId });
  return items;
}
