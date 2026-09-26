import { describe, expect, it } from 'vitest';
import { buildTriggerBubbleMessage, parseTriggerBubbleMessage } from './trigger-bubble-marker';
import type { TriggerSummary } from './trigger-summary';

const summary: TriggerSummary = {
  source: 'shortcut',
  provider: 'Shortcut',
  title: 'Fix flaky webhook test',
  subtitle: '#4821 · feature',
  fields: [{ label: 'Type', value: 'feature', tone: 'neutral' }],
  autoStart: true,
};

describe('trigger-bubble-marker', () => {
  it('coerces a LEGACY TriggerBubbleData payload into a TriggerSummary (no empty bubble)', () => {
    const legacyPayload = {
      source: 'shortcut',
      triggerRuleName: 'Legacy rule',
      autoStart: false,
      storyTitle: 'Legacy title',
      storyType: 'bug',
    };
    const message = `<!--TRIGGER_BUBBLE:${JSON.stringify(legacyPayload)}-->\n\nLegacy prompt`;

    const parsed = parseTriggerBubbleMessage(message);
    expect(parsed.triggerData?.source).toBe('shortcut');
    expect(parsed.triggerData?.title).toBe('Legacy title'); // storyTitle → title
    expect(parsed.triggerData?.fields.some((f) => f.value === 'bug')).toBe(true); // storyType → field
    expect(parsed.triggerContext).toBeNull();
    expect(parsed.fullPrompt).toBe('Legacy prompt');
  });

  it('round-trips a TriggerSummary; trailing text (the description) parses back as fullPrompt', () => {
    // The marker is just the prefix; the caller appends the rendered description after it.
    const message = `${buildTriggerBubbleMessage(summary)}## Trigger Context: Shortcut Story\n\nPrompt body`;
    const parsed = parseTriggerBubbleMessage(message);
    expect(parsed.triggerData?.source).toBe('shortcut');
    expect(parsed.triggerData?.title).toBe('Fix flaky webhook test');
    expect(parsed.triggerData?.fields[0]?.label).toBe('Type');
    expect(parsed.fullPrompt).toContain('Trigger Context: Shortcut Story');
  });

  it('round-trips the trigger context in the marker payload', () => {
    const message = buildTriggerBubbleMessage(summary, {
      source: 'shortcut',
      sourceAccountId: 'acct-1',
      eventType: 'shortcut_story',
      triggeredBy: { name: 'Pat' },
      timestamp: '2026-03-03T10:00:00.000Z',
      fullContent: {},
      autoStart: true,
    });

    const parsed = parseTriggerBubbleMessage(message);
    expect(parsed.triggerContext?.sourceAccountId).toBe('acct-1');
    expect(parsed.triggerContext?.triggeredBy?.name).toBe('Pat');
  });

  it('escapes the marker delimiter in JSON and parses it back safely', () => {
    const message = `${buildTriggerBubbleMessage({ ...summary, title: 'Fix --> delimiter' })}Prompt with delimiter payload`;
    const parsed = parseTriggerBubbleMessage(message);
    expect(parsed.triggerData?.title).toBe('Fix --> delimiter');
    expect(parsed.fullPrompt).toBe('Prompt with delimiter payload');
  });

  it('returns original message when marker is missing', () => {
    const parsed = parseTriggerBubbleMessage('just a normal user message');
    expect(parsed.triggerData).toBeNull();
    expect(parsed.fullPrompt).toBe('just a normal user message');
  });

  it('returns original message when marker json is invalid', () => {
    const malformed = '<!--TRIGGER_BUBBLE:{oops}--> hello';
    const parsed = parseTriggerBubbleMessage(malformed);
    expect(parsed.triggerData).toBeNull();
    expect(parsed.fullPrompt).toBe(malformed);
  });
});
