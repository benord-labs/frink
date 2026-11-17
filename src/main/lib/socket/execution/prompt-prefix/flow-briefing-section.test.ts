import { describe, expect, it } from 'vitest';
import { renderFlowBriefingSection } from './flow-briefing-section';

describe('renderFlowBriefingSection', () => {
  it('preserves the user briefing without adding provenance prose', () => {
    expect(renderFlowBriefingSection('Every message is machine-generated.')).toBe(
      '## Flow Briefing\n\nEvery message is machine-generated.',
    );
  });
});
