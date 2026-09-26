// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBriefFocusHighlight } from './use-brief-focus-highlight';

describe('useBriefFocusHighlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // happy-dom lacks scrollIntoView; the hook calls it on the attached element.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is inert at nonce 0 / undefined', () => {
    const { result } = renderHook(({ nonce }) => useBriefFocusHighlight(nonce), {
      initialProps: { nonce: 0 as number | undefined },
    });
    expect(result.current.highlighted).toBe(false);
  });

  it('highlights on a nonce bump, scrolls the target, then clears after the timeout', () => {
    const { result, rerender } = renderHook(({ nonce }) => useBriefFocusHighlight(nonce), {
      initialProps: { nonce: 0 },
    });
    const el = document.createElement('div');
    result.current.ref.current = el;

    act(() => rerender({ nonce: 1 }));
    expect(result.current.highlighted).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });

    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.highlighted).toBe(false);
  });

  it('re-highlights on every subsequent bump', () => {
    const { result, rerender } = renderHook(({ nonce }) => useBriefFocusHighlight(nonce), {
      initialProps: { nonce: 1 },
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.highlighted).toBe(false);

    act(() => rerender({ nonce: 2 }));
    expect(result.current.highlighted).toBe(true);
  });
});
