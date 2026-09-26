import { describe, expect, it } from 'vitest';
import {
  buildHiddenWakeMessage,
  isHiddenWakeMessage,
  stripHiddenWakeMarker,
} from './hidden-wake-marker';

// The marker contract spans three processes: task-executor wraps, the renderer hides, and the
// socket executor strips before the model sees the text — round-trip must be exact.
describe('hidden-wake-marker', () => {
  it('round-trips: build → detect → strip returns the original text', () => {
    const wrapped = buildHiddenWakeMessage('carry on from where you left off');
    expect(isHiddenWakeMessage(wrapped)).toBe(true);
    expect(stripHiddenWakeMarker(wrapped)).toBe('carry on from where you left off');
  });

  it('leaves ordinary user messages untouched', () => {
    expect(isHiddenWakeMessage('fix the login bug')).toBe(false);
    expect(stripHiddenWakeMarker('fix the login bug')).toBe('fix the login bug');
  });
});
