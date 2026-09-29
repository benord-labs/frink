import { describe, expect, it } from 'vitest';
import { LINE, MAX_LINES, messageInputSizing } from './input-sizing';

describe('messageInputSizing', () => {
  it('lets the phone text view grow and scroll on its own, from the first line', () => {
    for (const contentHeight of [LINE, LINE * 3, LINE * 40]) {
      const sizing = messageInputSizing(false, LINE, contentHeight, true);
      // Always scrollable, never a hand-fixed height or lineHeight: those clipped the first line on iOS.
      expect(sizing.scrollEnabled).toBe(true);
      expect(sizing.measure).toBe(false);
      expect(sizing.style).not.toHaveProperty('height');
      expect(sizing.style).not.toHaveProperty('lineHeight');
      expect(sizing.style).toMatchObject({ minHeight: LINE, maxHeight: LINE * MAX_LINES });
    }
  });

  it('keeps the measured height in the web preview and scrolls only past the cap', () => {
    expect(messageInputSizing(true, LINE, LINE * 3, true)).toMatchObject({
      style: { height: LINE * 3 },
      scrollEnabled: false,
      measure: true,
    });
    expect(messageInputSizing(true, LINE, LINE * 10, true)).toMatchObject({
      style: { height: LINE * MAX_LINES },
      scrollEnabled: true,
    });
    // A cleared draft collapses even though the textarea still reports its old height.
    expect(messageInputSizing(true, LINE, LINE * 4, false).style.height).toBe(LINE);
  });
});
