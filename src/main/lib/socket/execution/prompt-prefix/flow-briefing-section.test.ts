import { describe, expect, it } from 'vitest';
import { FLOW_BRIEFING_PROVENANCE_NOTE, renderFlowBriefingSection } from './flow-briefing-section';

describe('renderFlowBriefingSection', () => {
  it('keeps the user briefing verbatim and appends the provenance note after it', () => {
    const out = renderFlowBriefingSection('Every message is machine-generated.');
    expect(out).toBe(
      `## Flow Briefing\n\nEvery message is machine-generated.\n\n${FLOW_BRIEFING_PROVENANCE_NOTE}`,
    );
    expect(FLOW_BRIEFING_PROVENANCE_NOTE).toContain('a person types into this chat');
  });
});
