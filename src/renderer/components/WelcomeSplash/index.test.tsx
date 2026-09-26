// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the lazy 3D scene so no real WebGL/r3f is exercised (happy-dom has no GL context). The mock
// signals onReady from an effect (like the real scene's first committed frame), gated by `hoisted`
// so a test can simulate "Canvas mounted but never produced a frame".
const hoisted = vi.hoisted(() => ({ onReadyEnabled: true }));
vi.mock('./FrinkScene', () => ({
  FrinkScene: ({ onReady, active }: { onReady?: () => void; active: boolean }) => {
    // biome-ignore lint/correctness/useExhaustiveDependencies: fire-once on mount, mirrors the real scene
    useEffect(() => {
      if (hoisted.onReadyEnabled) onReady?.();
    }, []);
    return <div data-testid="frink-scene" data-active={String(active)} />;
  },
}));

import { WelcomeSplash } from './index';

const STORAGE_KEY = 'frink:has-seen-welcome';
const MARK_VIOLET = '#7c5cff';

/** Fake `(prefers-reduced-motion: reduce)` MediaQueryList (pattern from text-shimmer.test.tsx). */
function stubReducedMotion(reduced: boolean) {
  window.matchMedia = vi.fn((query: string) => {
    const isReduced = query === '(prefers-reduced-motion: reduce)';
    return {
      get matches() {
        return isReduced ? reduced : false;
      },
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as MediaQueryList;
  });
}

/** hasWebGl() reads canvas.getContext('webgl'/'webgl2') once in a useState initializer. */
function stubWebGl(ok: boolean) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation((type: string) =>
      (type === 'webgl' || type === 'webgl2') && ok ? ({} as RenderingContext) : null,
    );
}

const markPaths = (container: HTMLElement) => [...container.querySelectorAll('svg path')];
const filledMarkPath = (container: HTMLElement) =>
  container.querySelector(`svg path[fill="${MARK_VIOLET}"]`);
const hollowMarkPath = (container: HTMLElement) => container.querySelector('svg path[fill="none"]');

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  window.localStorage.clear();
  hoisted.onReadyEnabled = true;
});

describe('WelcomeSplash — mark fallback matrix', () => {
  // The 2D mark must be the SOLID filled image in every cell EXCEPT {motion-allowed, WebGL-ok},
  // where it is the animated hollow outline that hands off to the 3D scene. This locks the
  // animate↔allow3d coupling: a regression that decouples them (the no-WebGL hollow-outline bug)
  // re-breaks the [motion, no-WebGL] cell.
  it.each([
    { reduced: true, webgl: false },
    { reduced: true, webgl: true },
    { reduced: false, webgl: false },
  ])(
    'renders the solid filled mark when reduced=$reduced webgl=$webgl (no Canvas)',
    ({ reduced, webgl }) => {
      stubReducedMotion(reduced);
      stubWebGl(webgl);
      const { container } = render(<WelcomeSplash />);

      expect(markPaths(container).length).toBeGreaterThan(0);
      expect(filledMarkPath(container)).not.toBeNull();
      expect(hollowMarkPath(container)).toBeNull();
      expect(screen.queryByTestId('frink-scene')).toBeNull();
    },
  );

  it('renders the animated hollow trace + mounts the 3D scene when motion + WebGL are both available', async () => {
    stubReducedMotion(false);
    stubWebGl(true);
    const { container } = render(<WelcomeSplash />);
    await act(async () => {}); // flush the lazy() import so the Suspense resolves the 3D scene

    expect(hollowMarkPath(container)).not.toBeNull();
    expect(screen.getByTestId('frink-scene')).toBeInTheDocument();
  });
});

describe('WelcomeSplash — dismiss', () => {
  it('persists the seen-flag and hides the overlay after the exit delay', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    stubWebGl(false);
    render(<WelcomeSplash />);

    expect(screen.getByText('Welcome to Frink.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText('Welcome to Frink.')).not.toBeInTheDocument();
  });
});

describe('WelcomeSplash — seen-flag gate', () => {
  it('does not render once the welcome key has been set (show-once)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');
    stubReducedMotion(false);
    stubWebGl(false);
    const { container } = render(<WelcomeSplash />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Welcome to Frink.')).not.toBeInTheDocument();
  });
});

describe('WelcomeSplash — trace → 3D swap wiring', () => {
  it('crossfades to the 3D layer only once the scene is ready AND the outline has settled', async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    stubWebGl(true);
    hoisted.onReadyEnabled = true;
    const { container } = render(<WelcomeSplash />);
    await act(async () => {}); // flush the lazy() import → scene mounts + signals ready

    const traceWrapper = container.querySelector('svg')?.parentElement;
    const sceneWrapper = screen.getByTestId('frink-scene').parentElement;
    // Before TRACE_SETTLE_MS: scene ready but outline not settled → still on the 2D trace.
    expect(traceWrapper).toHaveClass('opacity-100');
    expect(sceneWrapper).toHaveClass('opacity-0');

    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(traceWrapper).toHaveClass('opacity-0');
    expect(sceneWrapper).toHaveClass('opacity-100');
  });

  it('stays on the 2D trace if the scene mounts but never signals ready (no committed frame)', async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    stubWebGl(true);
    hoisted.onReadyEnabled = false; // Canvas mounts but onReady is never called
    const { container } = render(<WelcomeSplash />);
    await act(async () => {}); // flush the lazy() import → scene mounts (but never signals ready)

    act(() => {
      vi.advanceTimersByTime(2200); // outline settles, but sceneReady stays false
    });
    expect(container.querySelector('svg')?.parentElement).toHaveClass('opacity-100');
    expect(screen.getByTestId('frink-scene').parentElement).toHaveClass('opacity-0');
  });
});

describe('WelcomeSplash — keyboard accessibility', () => {
  it('exposes the overlay as a labelled modal dialog', () => {
    stubReducedMotion(true);
    stubWebGl(false);
    render(<WelcomeSplash />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Welcome to Frink');
  });

  it('moves focus onto the dialog when it opens (announced before the action)', async () => {
    stubReducedMotion(true);
    stubWebGl(false);
    render(<WelcomeSplash />);
    await act(async () => {}); // let the open-focus effect run
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it.each(['Enter', 'Escape'])('dismisses the splash on %s', (key) => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    stubWebGl(false);
    render(<WelcomeSplash />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText('Welcome to Frink.')).not.toBeInTheDocument();
  });

  it('traps Tab on the sole CTA so focus never escapes to the app behind the overlay', () => {
    stubReducedMotion(true);
    stubWebGl(false);
    render(<WelcomeSplash />);
    const dialog = screen.getByRole('dialog');
    const button = screen.getByRole('button', { name: 'Get started' });
    dialog.focus(); // simulate focus drifting off the CTA onto the overlay
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(button);
  });
});
