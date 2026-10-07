import { describe, expect, it } from 'vitest';
import { hasTurnOutput } from './index';

describe('hasTurnOutput', () => {
  it('is false for a turn that failed before any reply', () => {
    expect(hasTurnOutput([])).toBe(false);
    expect(hasTurnOutput([null, { parts: [] }])).toBe(false);
  });

  it('ignores whitespace-only text and non-output parts', () => {
    expect(
      hasTurnOutput([
        { parts: [{ type: 'step-start' }, { type: 'text', text: '  \n' }, { type: 'data-x' }] },
      ]),
    ).toBe(false);
  });

  // A reasoning part opens empty before its first delta, so a turn can fail holding only that.
  it.each([
    ['empty reasoning', { type: 'reasoning', text: '' }],
    ['whitespace-only reasoning', { type: 'reasoning', text: ' \n\t' }],
    ['reasoning with no text', { type: 'reasoning' }],
    ['text with no text', { type: 'text' }],
  ])('is false when the turn only holds %s', (_label, part) => {
    expect(hasTurnOutput([{ parts: [part] }])).toBe(false);
  });

  it.each([
    ['text', { type: 'text', text: 'Working on it' }],
    ['reasoning', { type: 'reasoning', text: 'Thinking' }],
    ['a tool call', { type: 'tool-Bash' }],
    ['a dynamic tool call', { type: 'dynamic-tool' }],
    ['a persisted legacy tool call', { type: 'tool-invocation', toolName: 'Bash' }],
  ])('is true when any message holds %s', (_label, part) => {
    expect(hasTurnOutput([{ parts: [] }, { parts: [part] }])).toBe(true);
  });
});
