export type FlowListSectionId = 'needs_you' | 'flows' | 'disabled';

const SECTION_ORDER: FlowListSectionId[] = ['needs_you', 'flows', 'disabled'];

export const FLOW_LIST_SECTION_LABELS = {
  // biome-ignore lint/style/useNamingConvention: Section ids are snake_case keys.
  needs_you: 'Needs you',
  flows: 'Enabled',
  disabled: 'Disabled',
} satisfies Record<FlowListSectionId, string>;

/**
 * Awaiting input always needs the user; a failure only does while the flow is enabled.
 * Precedence is awaiting input > disabled > failed > the rest, so every flow lands in one section.
 */
function sectionFor(displayStatus: string | null, enabled: boolean): FlowListSectionId {
  if (displayStatus === 'awaiting_input') return 'needs_you';
  if (!enabled) return 'disabled';
  return displayStatus === 'failed' ? 'needs_you' : 'flows';
}

/** Groups already-sorted flows into ordered, non-empty sections, preserving input order. */
export function groupFlowsIntoSections<T extends { is_enabled?: boolean | null }>(
  flows: T[],
  displayStatusOf: (flow: T) => string | null,
): { id: FlowListSectionId; flows: T[] }[] {
  const buckets = new Map<FlowListSectionId, T[]>(SECTION_ORDER.map((id) => [id, []]));
  for (const flow of flows) {
    buckets.get(sectionFor(displayStatusOf(flow), flow.is_enabled ?? true))?.push(flow);
  }
  return SECTION_ORDER.map((id) => ({ id, flows: buckets.get(id) ?? [] })).filter(
    (section) => section.flows.length > 0,
  );
}
