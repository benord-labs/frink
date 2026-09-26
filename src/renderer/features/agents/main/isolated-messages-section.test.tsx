// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockObserverInstance = {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

const observerInstances: MockObserverInstance[] = [];

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string;
  readonly scrollMargin: string = '0px';
  readonly thresholds: ReadonlyArray<number>;

  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn((): IntersectionObserverEntry[] => []);

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options?.threshold)
      ? options?.threshold
      : [options?.threshold ?? 0];

    observerInstances.push({
      callback: this.callback,
      observe: this.observe,
      disconnect: this.disconnect,
    });
  }

  private readonly callback: IntersectionObserverCallback;
}

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useAtomValue: () => [],
  };
});

vi.mock('../stores/message-store', () => ({
  userMessageIdsForSubChatAtomFamily: () => 'mock-atom',
}));

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('@sentry/electron/renderer', () => ({ captureException: captureExceptionMock }));

vi.mock('./isolated-message-group', () => ({
  IsolatedMessageGroup: () => null,
}));

import { IsolatedMessagesSection } from './isolated-messages-section';

const isolatedSectionToolRegistry = {
  'tool-planning': {
    icon: () => null,
    title: () => 'Planning...',
  },
};

function triggerIntersection(index = 0, isIntersecting = true) {
  const instance = observerInstances[index];
  if (!instance) throw new Error(`No observer instance at index ${index}`);
  instance.callback(
    [
      {
        isIntersecting,
      } as IntersectionObserverEntry,
    ],
    {} as IntersectionObserver,
  );
}

function buildContainer(initialScrollTop: number): HTMLDivElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollTop', {
    value: initialScrollTop,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(container, 'scrollHeight', {
    value: 2000,
    writable: true,
    configurable: true,
  });
  return container;
}

function renderSection(params?: {
  containerScrollTop?: number;
  loadOlderMessages?: () => Promise<void>;
  hasOlderMessages?: boolean;
}) {
  const container = buildContainer(params?.containerScrollTop ?? 800);
  const chatContainerRef = {
    current: container,
  } as RefObject<HTMLElement | null>;

  const loadOlderMessages =
    params?.loadOlderMessages ??
    (async () => {
      return;
    });

  render(
    <IsolatedMessagesSection
      subChatId="sub-1"
      chatId="chat-1"
      taskId={null}
      isMobile={false}
      sandboxSetupStatus="ready"
      stickyTopClass=""
      UserBubbleComponent={() => null}
      ToolCallComponent={() => null}
      MessageGroupWrapper={({ children }) => <>{children}</>}
      toolRegistry={isolatedSectionToolRegistry}
      showChatRetryControl={false}
      retryInFlight={false}
      onRetryChat={() => {}}
      onCarryOnChat={() => {}}
      chatRetryTooltipText={null}
      loadOlderMessages={loadOlderMessages}
      hasOlderMessages={params?.hasOlderMessages ?? true}
      isLoadingOlderMessages={false}
      chatContainerRef={chatContainerRef}
      status="ready"
    />,
  );

  return { container, loadOlderMessages };
}

/** Content height after the prepended page adds 1200px above buildContainer's starting 2000. */
const HEIGHT_AFTER_PREPEND = 3200;
/** Offset the user is reading at when the load-older request fires. */
const SCROLL_TOP_AT_LOAD = 100;
/** Anchored result — 100 + (3200 - 2000). The message under the user's eye must not move. */
const ANCHORED_SCROLL_TOP = 1300;

function setContentHeight(container: HTMLElement, value: number) {
  Object.defineProperty(container, 'scrollHeight', { value, writable: true, configurable: true });
}

/** Moves the viewport upward and emits the scroll the top-intent gate listens for. */
function scrollUpTo(container: HTMLElement, scrollTop: number) {
  container.scrollTop = scrollTop;
  container.dispatchEvent(new Event('scroll'));
}

/**
 * Drives one load-older cycle whose prepended page grows the content by 1200px, returning
 * as soon as the fetch resolves — before any animation frame has run.
 */
async function loadOlderWithPrependedPage() {
  let viewport: HTMLDivElement | null = null;
  const loadOlderMessages = vi.fn(async () => {
    if (viewport) setContentHeight(viewport, HEIGHT_AFTER_PREPEND);
  });

  const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });
  viewport = container;

  // One upward scroll arms the top-intent gate; mount already recorded the 900 baseline.
  scrollUpTo(container, SCROLL_TOP_AT_LOAD);

  await act(async () => {
    triggerIntersection(0, true);
  });

  return { container, loadOlderMessages };
}

async function advanceTwoFrames() {
  await act(async () => {
    await vi.advanceTimersToNextFrame();
    await vi.advanceTimersToNextFrame();
  });
}

describe('IsolatedMessagesSection', () => {
  beforeEach(() => {
    cleanup();
    observerInstances.length = 0;
    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  it('does not load older on mount-time intersection without user upward scroll intent', async () => {
    const loadOlderMessages = vi.fn(async () => {
      return;
    });
    renderSection({ containerScrollTop: 0, loadOlderMessages });

    await act(async () => {
      triggerIntersection(0, true);
    });

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it('does not render sentinel or invoke loadOlderMessages when hasOlderMessages is false', () => {
    const loadOlderMessages = vi.fn(async () => {
      return;
    });
    renderSection({ hasOlderMessages: false, loadOlderMessages });

    expect(document.querySelector('[data-load-more-sentinel]')).toBeNull();
    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it('loads older when user has scrolled upward and is near top threshold', async () => {
    const loadOlderMessages = vi.fn(async () => {
      return;
    });
    const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });

    // Simulate upward user scrolling intent.
    container.scrollTop = 700;
    container.dispatchEvent(new Event('scroll'));
    container.scrollTop = 100;
    container.dispatchEvent(new Event('scroll'));

    await act(async () => {
      triggerIntersection(0, true);
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it('does not load older when user is not near top threshold', async () => {
    const loadOlderMessages = vi.fn(async () => {
      return;
    });
    const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });

    // User scrolls upward, but remains far from top.
    container.scrollTop = 700;
    container.dispatchEvent(new Event('scroll'));
    container.scrollTop = 450;
    container.dispatchEvent(new Event('scroll'));

    await act(async () => {
      triggerIntersection(0, true);
    });

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it('dedupes observer callbacks while loadOlder is in flight', async () => {
    let resolveLoadOlder: (() => void) | null = null;
    const loadOlderMessages = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoadOlder = resolve;
        }),
    );

    const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });
    container.scrollTop = 100;
    container.dispatchEvent(new Event('scroll'));

    await act(async () => {
      triggerIntersection(0, true);
      triggerIntersection(0, true);
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoadOlder?.();
    });
  });

  // The two tests below characterize the anchor restore that runs after a load-older prepend:
  // the offset it computes (prevScrollTop + height delta), and that the write is deferred past
  // the fetch rather than applied inline.
  //
  // Deliberate limits. They do not distinguish one animation frame from two — happy-dom has no
  // layout, so the second frame has nothing to wait for here. They also say nothing about
  // Chromium's own scroll anchoring, which the packaged app leaves at its default and which may
  // compensate for the same prepend independently of this code.
  //
  // rAF is faked rather than stubbed synchronously: happy-dom schedules it as a macrotask that
  // `await act()` never drains, and a synchronous stub would make an inline restore
  // indistinguishable from a deferred one — exactly what the second test exists to catch.
  it('restores the scroll anchor after older messages are prepended', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const { container, loadOlderMessages } = await loadOlderWithPrependedPage();

      await advanceTwoFrames();

      expect(loadOlderMessages).toHaveBeenCalledTimes(1);
      expect(container.scrollTop).toBe(ANCHORED_SCROLL_TOP);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers the anchor restore until after the prepend has laid out', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const { container, loadOlderMessages } = await loadOlderWithPrependedPage();

      // Fetch has resolved, but the restore must wait for the prepended content to lay out.
      expect(loadOlderMessages).toHaveBeenCalledTimes(1);
      expect(container.scrollTop).toBe(SCROLL_TOP_AT_LOAD);

      await advanceTwoFrames();

      expect(container.scrollTop).toBe(ANCHORED_SCROLL_TOP);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('load-older edge cases', () => {
    // The restore reads the viewport two frames after the fetch resolves. Everything below
    // covers something that can change in between, plus the gate boundary that admits it.

    it('does not start a second load-older while the anchor restore is still pending', async () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      try {
        let viewport: HTMLDivElement | null = null;
        let contentHeight = 2000;
        const loadOlderMessages = vi.fn(async () => {
          contentHeight += 1200;
          if (viewport) setContentHeight(viewport, contentHeight);
        });

        const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });
        viewport = container;
        scrollUpTo(container, SCROLL_TOP_AT_LOAD);

        await act(async () => {
          triggerIntersection(0, true);
        });

        // The fetch has resolved but the viewport has not moved yet, so the sentinel is still
        // in view and the observer can fire again. Loading a second page from this state
        // computes its delta against an already-grown height and lands the user mid-history.
        await act(async () => {
          triggerIntersection(0, true);
        });

        expect(loadOlderMessages).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('anchors from the request-time offset even if the user scrolls during the fetch', async () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      try {
        let resolveFetch: (() => void) | null = null;
        const loadOlderMessages = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveFetch = resolve;
            }),
        );

        const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });
        scrollUpTo(container, SCROLL_TOP_AT_LOAD);

        await act(async () => {
          triggerIntersection(0, true);
        });

        // Slow page: the user keeps reading and moves down before the response lands.
        scrollUpTo(container, 500);

        await act(async () => {
          setContentHeight(container, HEIGHT_AFTER_PREPEND);
          resolveFetch?.();
        });
        await advanceTwoFrames();

        // The request-time anchor wins: 100 + 1200, not 500 + 1200. Deliberate, and the reason
        // the restore assigns an absolute offset instead of `+=` — an absolute write is
        // idempotent against Chromium's own scroll anchoring, which a relative one would
        // double-count. Anyone tempted to honour the mid-fetch scroll must first make this
        // viewport overflow-anchor: none, or the reader lands a page adrift.
        expect(container.scrollTop).toBe(ANCHORED_SCROLL_TOP);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not move the viewport after the section unmounts mid-restore', async () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      try {
        const { container } = await loadOlderWithPrependedPage();

        // Closing a pane, or switching sub-chat (active-chat keys this subtree by subChatId),
        // unmounts the section while frames are pending. Inactive tabs stay mounted, so those
        // are the real paths. The scroll element outlives the section, and a late write would
        // move whatever owns it next.
        cleanup();
        await advanceTwoFrames();

        expect(container.scrollTop).toBe(SCROLL_TOP_AT_LOAD);
      } finally {
        vi.useRealTimers();
      }
    });

    it('loads older exactly at the top-intent threshold but not one pixel past it', async () => {
      const atThreshold = vi.fn(async () => {});
      const { container } = renderSection({
        containerScrollTop: 900,
        loadOlderMessages: atThreshold,
      });
      scrollUpTo(container, 200);
      await act(async () => {
        triggerIntersection(0, true);
      });
      expect(atThreshold).toHaveBeenCalledTimes(1);

      cleanup();
      observerInstances.length = 0;

      const pastThreshold = vi.fn(async () => {});
      const { container: other } = renderSection({
        containerScrollTop: 900,
        loadOlderMessages: pastThreshold,
      });
      scrollUpTo(other, 201);
      await act(async () => {
        triggerIntersection(0, true);
      });
      expect(pastThreshold).not.toHaveBeenCalled();
    });

    it('reports the failure, leaves the viewport alone and stays loadable when the fetch rejects', async () => {
      captureExceptionMock.mockClear();
      const loadOlderMessages = vi.fn(async () => {
        throw new Error('network down');
      });

      const { container } = renderSection({ containerScrollTop: 900, loadOlderMessages });
      scrollUpTo(container, SCROLL_TOP_AT_LOAD);

      await act(async () => {
        triggerIntersection(0, true);
      });

      expect(container.scrollTop).toBe(SCROLL_TOP_AT_LOAD);
      // Nothing else surfaces this: loadOlderError belongs to the hook, and a producer that
      // rejects has bypassed it. Without this capture the failure would be invisible.
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);

      // A failed page must not wedge the gate — a retry has to be able to fire.
      await act(async () => {
        triggerIntersection(0, true);
      });
      expect(loadOlderMessages).toHaveBeenCalledTimes(2);
    });
  });
});
