// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetLiveRunHydrationForTests,
  beginLiveRunHydration,
  completeLiveRunHydration,
  isLiveRunHydrationComplete,
  onLiveRunHydrationChange,
} from './renderer-recovery-ready';

describe('live-run hydration barrier', () => {
  beforeEach(() => {
    _resetLiveRunHydrationForTests();
  });

  it('starts complete so a queue with nothing to recover is never blocked', () => {
    expect(isLiveRunHydrationComplete()).toBe(true);
  });

  it('closes on begin and reopens on complete', () => {
    beginLiveRunHydration();
    expect(isLiveRunHydrationComplete()).toBe(false);

    completeLiveRunHydration();
    expect(isLiveRunHydrationComplete()).toBe(true);
  });

  it('notifies subscribers only on an actual state change', () => {
    const listener = vi.fn();
    const unsubscribe = onLiveRunHydrationChange(listener);

    completeLiveRunHydration(); // already complete — no-op
    expect(listener).not.toHaveBeenCalled();

    beginLiveRunHydration();
    expect(listener).toHaveBeenCalledTimes(1);

    beginLiveRunHydration(); // already begun — no-op
    expect(listener).toHaveBeenCalledTimes(1);

    completeLiveRunHydration();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    beginLiveRunHydration();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
