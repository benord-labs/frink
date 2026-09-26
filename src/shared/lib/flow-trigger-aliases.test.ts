import { describe, expect, it } from 'vitest';
import { applyTriggerAliases } from './flow-trigger-aliases';

describe('applyTriggerAliases', () => {
  it('aliases payload ← fullContent and event ← eventType (the regression)', () => {
    const out = applyTriggerAliases({
      eventType: 'story_assigned',
      fullContent: { story: { name: 'Fix nav', description: 'desc' } },
    });
    expect(out.event).toBe('story_assigned');
    expect(out.payload).toEqual({ story: { name: 'Fix nav', description: 'desc' } });
    // original keys are preserved
    expect(out.eventType).toBe('story_assigned');
  });

  it('does not overwrite an explicit event/payload', () => {
    const out = applyTriggerAliases({
      event: 'keep',
      payload: { kept: true },
      eventType: 'ignored',
      fullContent: { ignored: true },
    });
    expect(out.event).toBe('keep');
    expect(out.payload).toEqual({ kept: true });
  });

  it('leaves aliases absent when there is nothing to map (no false {{}} resolution)', () => {
    const out = applyTriggerAliases({ scheduledAt: '2026-05-31T09:00:00Z' });
    expect('event' in out).toBe(false);
    expect('payload' in out).toBe(false);
    expect(out.scheduledAt).toBe('2026-05-31T09:00:00Z');
  });

  it('handles null/undefined input', () => {
    expect(applyTriggerAliases(null)).toEqual({});
    expect(applyTriggerAliases(undefined)).toEqual({});
  });
});
