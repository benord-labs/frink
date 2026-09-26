// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextShimmer } from './text-shimmer';

/** Controls a fake `(prefers-reduced-motion: reduce)` MediaQueryList for tests. */
function stubReducedMotionPreference(initialReduced: boolean) {
  let prefersReduced = initialReduced;
  const changeListeners = new Set<() => void>();

  window.matchMedia = vi.fn((query: string) => {
    const isReducedQuery = query === '(prefers-reduced-motion: reduce)';
    const mql = {
      get matches() {
        return isReducedQuery ? prefersReduced : false;
      },
      media: query,
      addEventListener: (type: string, fn: EventListener) => {
        if (type === 'change' && isReducedQuery) changeListeners.add(fn as () => void);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        if (type === 'change' && isReducedQuery) changeListeners.delete(fn as () => void);
      },
      // Motion / legacy APIs
      addListener: (fn: () => void) => {
        if (isReducedQuery) changeListeners.add(fn);
      },
      removeListener: (fn: () => void) => {
        if (isReducedQuery) changeListeners.delete(fn);
      },
    };
    return mql as unknown as MediaQueryList;
  });

  return {
    setPrefersReduced(value: boolean) {
      prefersReduced = value;
      const event = { matches: value } as MediaQueryListEvent;
      for (const fn of changeListeners) (fn as (e: MediaQueryListEvent) => void)(event);
    },
  };
}

describe('TextShimmer', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
  });

  it('renders static muted text when prefers-reduced-motion is reduce (no shimmer)', async () => {
    stubReducedMotionPreference(true);
    render(
      <TextShimmer as="span" variant="spectrum">
        Squinting at the requirements
      </TextShimmer>,
    );

    const el = await screen.findByText('Squinting at the requirements');
    expect(el).toHaveClass('text-muted-foreground');
    expect(el).not.toHaveClass('text-transparent');
  });

  it('uses animated shimmer markup when motion is allowed', async () => {
    stubReducedMotionPreference(false);
    render(
      <TextShimmer as="span" duration={0.01}>
        Running
      </TextShimmer>,
    );

    const el = await screen.findByText('Running');
    expect(el).toHaveClass('text-transparent');
  });

  it('spectrum variant uses distinct markup from default mono shimmer (theme gradient path)', async () => {
    stubReducedMotionPreference(false);
    render(
      <TextShimmer as="span" variant="spectrum" duration={0.01}>
        Spectrum line
      </TextShimmer>,
    );

    const el = await screen.findByText('Spectrum line');
    expect(el).toHaveClass('text-transparent');
    // Default variant sets --base-color / --bg in className; spectrum does not (inline gradient only).
    expect(el.className).not.toContain('--base-color');
  });

  it('updates when the user toggles prefers-reduced-motion at runtime', async () => {
    const ctrl = stubReducedMotionPreference(false);
    render(
      <TextShimmer as="span" duration={0.01}>
        Toggle me
      </TextShimmer>,
    );

    await waitFor(() => {
      expect(screen.getByText('Toggle me')).toHaveClass('text-transparent');
    });

    ctrl.setPrefersReduced(true);

    await waitFor(() => {
      const el = screen.getByText('Toggle me');
      expect(el).toHaveClass('text-muted-foreground');
      expect(el).not.toHaveClass('text-transparent');
    });
  });

  it('spectrum variant still respects reduced motion (static muted text)', async () => {
    stubReducedMotionPreference(true);
    render(
      <TextShimmer as="span" variant="spectrum">
        Spectrum static
      </TextShimmer>,
    );

    const el = await screen.findByText('Spectrum static');
    expect(el).toHaveClass('text-muted-foreground');
  });

  it('queries matchMedia for prefers-reduced-motion on mount (sync initializer reads matches)', () => {
    const calls: string[] = [];
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      calls.push(query);
      return {
        get matches() {
          return false;
        },
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      } as unknown as MediaQueryList;
    });

    render(<TextShimmer as="span">Sync</TextShimmer>);

    expect(
      calls.filter((q) => q === '(prefers-reduced-motion: reduce)').length,
    ).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });
});
