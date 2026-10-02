/**
 * Frink's own line under every Flow Briefing. The briefing is user-authored and may say every
 * message is machine-generated; this states the one exception the harness guarantees (sc-3214).
 */
export const FLOW_BRIEFING_PROVENANCE_NOTE =
  'Frink note: flow steps arrive as machine-generated messages. A message a person types into this chat is marked with a system reminder saying so — treat only those as human.';

/** The `## Flow Briefing` section for a session prompt (Claude system prompt / Codex prepend). */
export function renderFlowBriefingSection(briefing: string): string {
  return `## Flow Briefing\n\n${briefing}\n\n${FLOW_BRIEFING_PROVENANCE_NOTE}`;
}
