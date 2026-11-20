// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStickToBottom } from '.';

// The chat's follow, through the local `use-stick-to-bottom` patch's native glide. happy-dom has no
// layout, smooth scrolling or `scrollend`, so geometry, observers and scroll events are hand-driven.
const VIEWPORT = 500;

/** Observers the hook created; the test drives the latest one by hand. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function notifyResize(target: Element, height: number): void {
  const entry: ResizeObserverEntry = {
    target,
    contentRect: new DOMRect(0, 0, 0, height),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  const observer = FakeResizeObserver.instances.at(-1);
  if (observer) observer.callback([entry], observer);
}

/** The library's frames chain through promises, so timers must advance asynchronously. */
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

function preferReducedMotion(): void {
  const realMatchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const list = realMatchMedia(query);
    Object.defineProperty(list, 'matches', { value: query.includes('reduce') });
    return list;
  });
}

async function setup({ cssSmooth = false } = {}) {
  const scroll = document.createElement('div');
  if (cssSmooth) {
    const sheet = document.createElement('style');
    sheet.textContent = '.css-smooth { scroll-behavior: smooth; }';
    document.head.append(sheet);
    scroll.className = 'css-smooth';
  }
  const content = document.createElement('div');
  content.textContent = 'streamed text';
  scroll.append(content);
  document.body.append(scroll);

  const geometry = { scrollHeight: 1000, contentHeight: 1000, top: 0 };
  /** The inline scroll-behavior in force at each instant write. */
  const behaviorAtWrite: string[] = [];
  Object.defineProperties(scroll, {
    scrollHeight: { get: () => geometry.scrollHeight },
    clientHeight: { get: () => VIEWPORT },
    scrollTop: {
      get: () => geometry.top,
      set: (value: number) => {
        behaviorAtWrite.push(scroll.style.scrollBehavior);
        // Rounded like Chromium's device-pixel snap at DPR 1.
        geometry.top = Math.round(Math.max(0, Math.min(value, geometry.scrollHeight - VIEWPORT)));
      },
    },
  });
  const scrollTo = vi.fn<(options: ScrollToOptions) => Promise<void> | undefined>(() => undefined);
  Object.defineProperty(scroll, 'scrollTo', { value: scrollTo });

  // The library instance, plus `jump`: the app's explicit scroll to bottom (Send, button, Cmd+Down).
  const hook = renderHook(() => {
    const chat = useChatStickToBottom();
    return { ...chat.stickToBottom, jump: chat.scrollToBottom };
  });
  act(() => {
    hook.result.current.scrollRef(scroll);
    hook.result.current.contentRef(content);
  });

  const target = () => geometry.scrollHeight - 1 - VIEWPORT;

  /** Content grows; waits out the library's resize-difference window so scroll events count. */
  const grow = async (by: number) => {
    geometry.scrollHeight += by;
    geometry.contentHeight += by;
    act(() => notifyResize(content, geometry.contentHeight));
    await advance(20);
  };

  /** One frame of a scroll the test performs itself (a glide step or a user scroll). */
  const scrollEvent = async (to: number) => {
    geometry.top = to;
    act(() => void scroll.dispatchEvent(new Event('scroll')));
    await advance(2);
  };

  const scrollEnd = () => act(() => void scroll.dispatchEvent(new Event('scrollend')));

  // First delivery is the `initial: 'instant'` landing at the bottom.
  await grow(0);
  await advance(100);
  expect(geometry.top).toBe(target());

  return {
    hook,
    scroll,
    content,
    geometry,
    behaviorAtWrite,
    scrollTo,
    target,
    grow,
    scrollEvent,
    scrollEnd,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.head.replaceChildren();
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new MouseEvent('mouseup'));
  document.dispatchEvent(new PointerEvent('pointerup'));
  FakeResizeObserver.instances = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('use-stick-to-bottom native smooth follow (local patch)', () => {
  it('follows growth with one native smooth scroll and no per-frame writes', async () => {
    const { geometry, scrollTo, target, grow } = await setup();
    const before = geometry.top;

    await grow(200);
    // Inside the idle window: a spring would have written scrollTop on every frame by now.
    await advance(250);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: target(), behavior: 'smooth' });
    expect(geometry.top).toBe(before);
  });

  it('holds growth that lands mid-glide and re-issues once the glide ends', async () => {
    const { scrollTo, target, grow, scrollEvent, scrollEnd } = await setup();

    await grow(200);
    const firstTarget = target();
    await grow(200);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    await scrollEvent(firstTarget);
    scrollEnd();

    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: target(), behavior: 'smooth' });
  });

  it('settles on the idle timer when no scrollend arrives, ignoring a late promise', async () => {
    const { scrollTo, grow } = await setup();
    let resolveFirst!: () => void;
    scrollTo.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)));

    await grow(200);
    await grow(200);
    await advance(320);
    expect(scrollTo).toHaveBeenCalledTimes(2);

    await act(async () => resolveFirst());
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('drops the glide when an instant pin writes through state.scrollTop', async () => {
    const { hook, scrollTo, target, grow } = await setup();

    await grow(200);
    act(() => {
      hook.result.current.state.scrollTop = target();
    });
    await grow(200);

    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('does not re-issue for a sub-pixel shortfall', async () => {
    const { scrollTo, target, grow, scrollEvent, scrollEnd } = await setup();

    await grow(200);
    await scrollEvent(target() - 0.5);
    scrollEnd();

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('pauses rather than releases for a drag-selection mid-glide, then catches up', async () => {
    const { hook, content, scrollTo, grow, scrollEvent, scrollEnd } = await setup();

    await grow(200);
    document.dispatchEvent(new MouseEvent('mousedown'));
    const text = content.firstChild;
    if (!(text instanceof Text)) throw new Error('setup renders a text node');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()?.addRange(range);

    await scrollEvent(600);
    expect(hook.result.current.state.isAtBottom).toBe(true);
    expect(hook.result.current.state.escapedFromLock).toBe(false);

    scrollEnd();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    act(() => void document.dispatchEvent(new MouseEvent('mouseup')));
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('releases on a scroll up mid-glide and does not re-issue', async () => {
    const { hook, geometry, scrollTo, grow, scrollEvent, scrollEnd } = await setup();

    await grow(200);
    await scrollEvent(geometry.top - 100);
    scrollEnd();

    expect(hook.result.current.state.isAtBottom).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['promise', 'scroll'],
    ['scroll', 'promise'],
  ])(
    'does not re-issue over a user scroll up that interrupts the glide (%s, then %s)',
    async (first) => {
      const { hook, geometry, scrollTo, grow, scrollEnd } = await setup();
      let interrupt!: () => void;
      scrollTo.mockImplementationOnce(() => new Promise<void>((resolve) => (interrupt = resolve)));
      const userScroll = () => {
        geometry.top -= 40;
        act(() => void hook.result.current.scrollRef.current?.dispatchEvent(new Event('scroll')));
      };

      await grow(200);
      if (first === 'scroll') userScroll();
      await act(async () => interrupt());
      if (first === 'promise') userScroll();
      expect(scrollTo).toHaveBeenCalledTimes(1);

      await advance(2);
      scrollEnd();
      expect(hook.result.current.state.isAtBottom).toBe(false);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'an upward-scroll key',
      (el: HTMLElement) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
      },
    ],
    [
      'a press on the scrollbar',
      (el: HTMLElement) => {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      },
    ],
    [
      'a touch drag',
      (el: HTMLElement) => {
        el.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [{ clientY: 100 }] }));
        el.dispatchEvent(Object.assign(new Event('touchmove'), { touches: [{ clientY: 160 }] }));
      },
    ],
  ])('releases on %s even when the scroll lands in a streaming resize', async (_, gesture) => {
    const { hook, geometry, content, scroll, scrollTo, grow } = await setup();

    await grow(200);
    act(() => {
      gesture(scroll);
      geometry.scrollHeight += 20;
      geometry.contentHeight += 20;
      notifyResize(content, geometry.contentHeight);
      geometry.top -= 120;
      scroll.dispatchEvent(new Event('scroll'));
    });
    await advance(400);

    expect(hook.result.current.state.isAtBottom).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // A clamp with no resize signal reads as a user scroll up and releases, as before (see the
  // release test); MessageGroup's newest-two exemption keeps settling groups from snapping.
  it('resumes following after an upward clamp that arrives with a content resize', async () => {
    const { hook, geometry, content, scrollTo, grow } = await setup();

    await grow(200);
    // A content-visibility group snapping back: content shrinks and the browser clamps scrollTop.
    geometry.scrollHeight -= 30;
    geometry.contentHeight -= 30;
    geometry.top -= 60;
    act(() => {
      notifyResize(content, geometry.contentHeight);
      hook.result.current.scrollRef.current?.dispatchEvent(new Event('scroll'));
    });
    await advance(400);

    expect(hook.result.current.state.isAtBottom).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('re-locks when the user scrolls back down in the same gesture that released a glide', async () => {
    const { hook, geometry, scrollTo, target, grow, scrollEvent } = await setup();

    await grow(200);
    await scrollEvent(geometry.top - 100);
    await scrollEvent(target());

    expect(hook.result.current.state.isAtBottom).toBe(true);
    expect(hook.result.current.state.escapedFromLock).toBe(false);
    await grow(200);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('still makes instant writes instant when CSS sets scroll-behavior: smooth', async () => {
    const { scroll, behaviorAtWrite } = await setup({ cssSmooth: true });

    expect(behaviorAtWrite).toContain('auto');
    expect(behaviorAtWrite).not.toContain('');
    expect(scroll.style.scrollBehavior).toBe('');
  });

  it('jumps instead of gliding under reduced motion', async () => {
    preferReducedMotion();
    const { geometry, scrollTo, target, grow } = await setup();

    await grow(200);
    await advance(100);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(geometry.top).toBe(target());
  });

  it('makes an explicit scroll to bottom instant under reduced motion', async () => {
    preferReducedMotion();
    const { hook, geometry, scrollTo, target, scrollEvent } = await setup();

    await scrollEvent(geometry.top - 300);
    act(() => hook.result.current.jump());
    await advance(20);

    expect(geometry.top).toBe(target());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('hands an explicit scrollToBottom spring to the glide once it lands', async () => {
    const { hook, geometry, scrollTo, target, grow, scrollEvent } = await setup();
    scrollTo.mockImplementation(({ top }) => void (geometry.top = top ?? geometry.top));

    await scrollEvent(geometry.top - 100);
    act(() => hook.result.current.jump());
    await advance(20);
    await grow(200);
    expect(scrollTo).not.toHaveBeenCalled();

    // Growth during the spring goes to the glide: re-queueing the spring chased a stream forever.
    await advance(3000);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: target(), behavior: 'smooth' });
    // The library leaves this set after its own scrollToBottom(); following must not need it clear.
    expect(hook.result.current.state.escapedFromLock).toBe(true);

    await grow(200);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});
