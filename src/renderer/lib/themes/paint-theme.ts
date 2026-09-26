import * as Sentry from '@sentry/electron/renderer';
import type { createStore } from 'jotai';
import {
  type ActivePalette,
  applyGlass,
  applyPalette,
  paintedPalette,
  THEME_SWITCHING_CLASS,
} from './palette/apply';
import { findTheme, isStockTheme } from './palette/built-in-themes';
import { resolveActivePalette, type ThemeHalves } from './palette/resolve';
import { type Appearance, ROLES } from './palette/roles';
import { getStockPalette } from './palette/stock-palette';
import {
  activePaletteAtom,
  contrastAtom,
  customThemesAtom,
  themeHalvesAtom,
  transparencyAtom,
} from './palette/theme-atoms';
import type { ThemeDefinition } from './palette/theme-schema';

/** index.html paints its loader from this before any bundle runs. */
const BOOT_BG_KEY = 'frink:boot-bg';

type ThemeSelection = {
  halves: ThemeHalves;
  customThemes: readonly ThemeDefinition[];
  appearance: Appearance;
  contrast: number;
};

let releaseFrame = 0;

/** Holds `theme-switching` on <html> through the next painted frame, so nothing animates a switch. */
export function holdThemeSwitching(): void {
  const html = document.documentElement;
  html.classList.add(THEME_SWITCHING_CLASS);
  cancelAnimationFrame(releaseFrame);
  releaseFrame = requestAnimationFrame(() => {
    releaseFrame = requestAnimationFrame(() => html.classList.remove(THEME_SWITCHING_CLASS));
  });
}

function samePalette(a: ActivePalette, b: ActivePalette): boolean {
  return (
    a.themeId === b.themeId &&
    a.appearance === b.appearance &&
    a.syntax === b.syntax &&
    a.stock === b.stock &&
    a.inline === b.inline &&
    ROLES.every((role) => a.colors[role] === b.colors[role])
  );
}

/**
 * Resolves the selection, paints it on <html> and returns the palette for consumers. When
 * `current` is already on <html> and equal, it is returned as is: no repaint, no new object.
 */
export function paintTheme(
  selection: ThemeSelection,
  current: ActivePalette | null = null,
): ActivePalette {
  const palette = resolveActivePalette(selection);
  if (current && current === paintedPalette() && samePalette(palette, current)) return current;
  holdThemeSwitching();
  applyPalette(palette);
  return palette;
}

/** Saves each appearance's window colour for index.html; stock stays with its static loader CSS. */
export function writeBootBackground(
  halves: ThemeHalves,
  customThemes: readonly ThemeDefinition[],
): void {
  const boot: Partial<Record<Appearance, string>> = {};
  for (const appearance of ['light', 'dark'] as const) {
    const theme = findTheme(halves[appearance], customThemes);
    if (!isStockTheme(theme)) boot[appearance] = theme[appearance].background;
  }
  localStorage.setItem(BOOT_BG_KEY, JSON.stringify(boot));
}

/**
 * Paints the stored theme on <html>: at boot before React's first render, in the appearance
 * index.html chose, and when the theme editor hands <html> back. A failure is reported, not thrown.
 */
export function paintStoredTheme(store: ReturnType<typeof createStore>): void {
  try {
    // Read both stock palettes now, while the DOM is empty and the forced recalcs are cheap.
    getStockPalette('light');
    getStockPalette('dark');
    const appearance = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const palette = paintTheme({
      halves: store.get(themeHalvesAtom),
      customThemes: store.get(customThemesAtom),
      appearance,
      contrast: store.get(contrastAtom),
    });
    store.set(activePaletteAtom, palette);
    applyGlass(store.get(transparencyAtom), appearance);
  } catch (error) {
    Sentry.captureException(error, { tags: { surface: 'theme-boot-or-handback-paint' } });
  }
}
