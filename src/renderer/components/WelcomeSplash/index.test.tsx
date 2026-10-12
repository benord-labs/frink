// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeSplash } from './index';

const STORAGE_KEY = 'frink:has-seen-welcome';
const MARK_VIOLET = '#7c5cff';
const HEADLINE = 'Welcome to Frink';

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

const markPaths = (container: HTMLElement) => [
  ...container.querySelectorAll('svg[viewBox="140 64 220 372"] path'),
];

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
  window.localStorage.clear();
});

describe('WelcomeSplash — mark', () => {
  it('is the solid violet mark with no outline when motion is reduced', () => {
    stubReducedMotion(true);
    const { container } = render(<WelcomeSplash />);
    const paths = markPaths(container);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path).toHaveAttribute('fill', MARK_VIOLET);
      expect(path).not.toHaveAttribute('stroke');
    }
  });

  it('draws its outline in the same violet when motion is allowed', () => {
    stubReducedMotion(false);
    const { container } = render(<WelcomeSplash />);
    for (const path of markPaths(container)) {
      expect(path).toHaveAttribute('stroke', MARK_VIOLET);
    }
  });
});

describe('WelcomeSplash — copy', () => {
  it('says what Frink is and which accounts it runs on', () => {
    stubReducedMotion(true);
    render(<WelcomeSplash />);
    expect(screen.getByRole('heading', { level: 1, name: HEADLINE })).toBeInTheDocument();
    expect(screen.getByText('Fine-tuned automations, for everyone.')).toBeInTheDocument();
    expect(screen.getByText(/your own Claude or OpenAI account/)).toBeInTheDocument();
  });
});

describe('WelcomeSplash — dismiss', () => {
  it('persists the seen-flag and hides the overlay after the exit delay', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    render(<WelcomeSplash />);

    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });
});

describe('WelcomeSplash — seen-flag gate', () => {
  it('does not render once the welcome key has been set (show-once)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');
    stubReducedMotion(false);
    const { container } = render(<WelcomeSplash />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('WelcomeSplash — keyboard accessibility', () => {
  it('exposes the overlay as a labelled modal dialog', () => {
    stubReducedMotion(true);
    render(<WelcomeSplash />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Welcome to Frink');
  });

  it('moves focus onto the dialog when it opens (announced before the action)', async () => {
    stubReducedMotion(true);
    render(<WelcomeSplash />);
    await act(async () => {}); // let the open-focus effect run
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it.each(['Enter', 'Escape'])('dismisses the splash on %s', (key) => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    render(<WelcomeSplash />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  it('traps Tab on the sole CTA so focus never escapes to the app behind the overlay', () => {
    stubReducedMotion(true);
    render(<WelcomeSplash />);
    const dialog = screen.getByRole('dialog');
    const button = screen.getByRole('button', { name: 'Get started' });
    dialog.focus(); // simulate focus drifting off the CTA onto the overlay
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(button);
  });
});
