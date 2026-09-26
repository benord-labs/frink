// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingBadge, LOGO_H, LOGO_W } from './FloatingBadge';

vi.mock('@/features/sidebar/unified/components/SidebarHeader/FrinkLogo', () => ({
  FrinkLogo: () => <span data-testid="frink-logo-mock" />,
}));

function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
}

describe('FloatingBadge', () => {
  beforeEach(() => {
    setViewport(2000, 2000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-clamps the logo to the viewport on window resize when the window shrinks', () => {
    // Avoid the first rAF frame moving `posRef` before `resize` — we only test onWindowResize clamping.
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    // Deterministic: start near the bottom-right of a large view; maxX/Y use LOGO_W/LOGO_H.
    let n = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      if (n < 2) {
        n += 1;
        return 0.99;
      }
      n += 1;
      return 0.1;
    });

    const onDismiss = vi.fn();
    render(<FloatingBadge onDismiss={onDismiss} />);
    const wSmall = 300;
    const hSmall = 250;
    const moving = screen.getByTestId('ee-floating-badge-layer');
    expect(moving).toBeInstanceOf(HTMLDivElement);

    act(() => {
      setViewport(wSmall, hSmall);
      window.dispatchEvent(new Event('resize'));
    });

    // Prior pos was 0.99*max* — must clamp to (inner − logo) for the shrunk viewport.
    expect(moving.style.transform).toBe(
      `translate3d(${wSmall - LOGO_W}px, ${hSmall - LOGO_H}px, 0)`,
    );
  });

  it('calls onDismiss for window mousedown and keydown', () => {
    const onDismiss = vi.fn();
    render(<FloatingBadge onDismiss={onDismiss} />);

    act(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
