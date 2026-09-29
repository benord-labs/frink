import type { MobileFlow } from '../../../../src/shared/types/remote/mobile';
import { runStatus, shortAge, type Status, type StatusTone } from '../../lib/status';

type SectionId = 'needs_you' | 'enabled' | 'disabled';
export type FlowSection = { id: SectionId; title: string; flows: MobileFlow[] };

const SECTIONS: Array<{ id: SectionId; title: string }> = [
  { id: 'needs_you', title: 'Needs you' },
  { id: 'enabled', title: 'Enabled' },
  { id: 'disabled', title: 'Disabled' },
];

/** The live run's status, else the most recent run's: what the row reports. */
function shownStatus(flow: MobileFlow): string | null {
  return flow.status ?? flow.lastRun?.status ?? null;
}

export function flowStatus(flow: MobileFlow): Status {
  return runStatus(shownStatus(flow));
}

/** Mirrors the desktop Flows list: a wait on you always needs you, a failure only while enabled. */
function sectionOf(flow: MobileFlow): SectionId {
  const status = shownStatus(flow);
  if (status === 'awaiting_input') return 'needs_you';
  if (!flow.enabled) return 'disabled';
  return status === 'failed' ? 'needs_you' : 'enabled';
}

function matches(flow: MobileFlow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${flow.name} ${flow.description}`.toLowerCase().includes(needle);
}

/** Non-empty sections in a fixed order; the computer's order is kept inside each. */
export function flowSections(flows: MobileFlow[], query = ''): FlowSection[] {
  const shown = flows.filter((flow) => matches(flow, query));
  return SECTIONS.map((section) => ({
    ...section,
    flows: shown.filter((flow) => sectionOf(flow) === section.id),
  })).filter((section) => section.flows.length > 0);
}

// States worth a word even on a disabled Flow: something is happening or waiting right now.
const ONGOING = new Set(['running', 'pending', 'queued', 'awaiting_input', 'paused']);

/** The right-hand slot: a state word when there is one, "Off", or when it last ran. */
export function flowTrailing(
  flow: MobileFlow,
  now = Date.now(),
): { text: string; tone: StatusTone } | null {
  const status = shownStatus(flow);
  const { word, tone } = runStatus(status);
  if (status && ONGOING.has(status)) return { text: word, tone };
  if (!flow.enabled) return { text: 'Off', tone: 'quiet' };
  if (status === 'failed' || status === 'cancelled') return { text: word, tone };
  const age = shortAge(flow.lastRun?.at, now);
  return age ? { text: age, tone: 'quiet' } : null;
}
