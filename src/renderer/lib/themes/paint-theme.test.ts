// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';
import {
  holdThemeSwitching,
  paintStoredTheme,
  paintTheme,
  writeBootBackground,
} from './paint-theme';
import { THEME_SWITCHING_CLASS } from './palette/apply';
import { hexToHslTriplet } from './palette/color';
import { activePaletteAtom, themeHalvesAtom } from './palette/theme-atoms';
import { installStockSheet } from './stock-sheet-fixture';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/electron/renderer', () => sentry);

installStockSheet();

const AMBER_DARK = {
  halves: { light: 'frink', dark: 'amber' },
  customThemes: [],
  appearance: 'dark' as const,
  contrast: 100,
};

describe('holdThemeSwitching', () => {
  it('holds theme-switching on <html> through the next painted frame', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { classList } = document.documentElement;
    try {
      holdThemeSwitching();
      vi.advanceTimersToNextFrame();
      expect(classList.contains(THEME_SWITCHING_CLASS)).toBe(true);
      vi.advanceTimersToNextFrame();
      expect(classList.contains(THEME_SWITCHING_CLASS)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('paintTheme', () => {
  it('keeps the painted palette when nothing changed and repaints when it did', () => {
    const painted = paintTheme(AMBER_DARK);
    expect(paintTheme(AMBER_DARK, painted)).toBe(painted);

    const sharper = paintTheme({ ...AMBER_DARK, contrast: 150 }, painted);
    expect(sharper).not.toBe(painted);
    expect(document.documentElement.style.getPropertyValue('--foreground')).toBe(
      hexToHslTriplet(sharper.colors.text),
    );
  });
});

describe('writeBootBackground', () => {
  it("saves each non-stock appearance's window colour for index.html", () => {
    writeBootBackground(AMBER_DARK.halves, []);
    expect(JSON.parse(localStorage.getItem('frink:boot-bg') ?? '')).toEqual({ dark: '#101010' });
  });
});

describe('paintStoredTheme', () => {
  it('paints and commits the stored theme in the appearance index.html set', () => {
    const html = document.documentElement;
    html.className = 'dark';
    const store = createStore();
    store.set(themeHalvesAtom, { light: 'frink', dark: 'amber' });

    paintStoredTheme(store);

    expect(store.get(activePaletteAtom)).toMatchObject({ themeId: 'amber', appearance: 'dark' });
    expect(html.style.getPropertyValue('--background')).toBe(hexToHslTriplet('#101010'));
    expect(html.style.getPropertyValue('--glass-rim')).toBe('0.19');
  });

  it('reports a failure under a tag naming boot and hand-back, without throwing', () => {
    const store = createStore();
    const failure = new Error('storage unavailable');
    vi.spyOn(store, 'get').mockImplementation(() => {
      throw failure;
    });

    expect(() => paintStoredTheme(store)).not.toThrow();
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      tags: { surface: 'theme-boot-or-handback-paint' },
    });
  });
});
