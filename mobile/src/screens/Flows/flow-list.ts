import type { MobileFlow } from '@frink/shared/types/remote/mobile';
import { runStatus, shortAge, type Status, type StatusTone } from '../../lib/status';

type SectionId = 'needs_you' | 'running' | 'paused' | 'results';
export type FlowSection = { id: SectionId; title: string; flows: MobileFlow[] };

const SECTIONS: Array<{ id: SectionId; title: string }> = [
  { id: 'needs_you', title: 'Needs you' },
  { id: 'running', title: 'Running' },
  { id: 'paused', title: 'Paused' },
  { id: 'results', title: 'Recent results' },
];
const RUNNING = new Set(['running', 'pending', 'queued']);

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

/** Only a human wait needs an answer; a user pause and finished results stay separate. */
function sectionOf(flow: MobileFlow): SectionId | null {
  if (!flowRunId(flow)) return null;
  const status = shownStatus(flow);
  if (status === 'awaiting_input') return 'needs_you';
  if (status && RUNNING.has(status)) return 'running';
  if (status === 'paused') return 'paused';
  return 'results';
}

export function matchingFlows(flows: MobileFlow[], query = ''): MobileFlow[] {
  const needle = query.trim().toLowerCase();
  return flows.filter((flow) => `${flow.name} ${flow.description}`.toLowerCase().includes(needle));
}

/** What is happening now, in a fixed order; the computer's order is kept inside each section. */
export function flowSections(flows: MobileFlow[], query = ''): FlowSection[] {
  const shown = matchingFlows(flows, query);
  const seen = new Set<string>();
  return SECTIONS.map((section) => {
    const items = shown.filter((flow) => {
      const id = flowRunId(flow);
      if (!id || sectionOf(flow) !== section.id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (section.id !== 'results') return { ...section, flows: items };
    const newest = [...items].sort((a, b) =>
      (b.lastRun?.at ?? '').localeCompare(a.lastRun?.at ?? ''),
    );
    return { ...section, flows: newest };
  }).filter((section) => section.flows.length > 0);
}

// States worth a word: something is happening or waiting right now, or went wrong.
const WORDED = new Set([
  'running',
  'pending',
  'queued',
  'awaiting_input',
  'paused',
  'failed',
  'cancelled',
]);

/** The right-hand slot of an activity row: a state word, or when it last ran. */
export function flowTrailing(
  flow: MobileFlow,
  now = Date.now(),
): { text: string; tone: StatusTone } | null {
  const status = shownStatus(flow);
  const { word, tone } = runStatus(status);
  if (status && WORDED.has(status)) return { text: word, tone };
  const age = shortAge(flow.lastRun?.at, now);
  return age ? { text: age, tone: 'quiet' } : null;
}
