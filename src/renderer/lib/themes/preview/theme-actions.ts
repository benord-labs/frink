import { flushSync } from 'react-dom';
import { isStockTheme, type Theme, uniqueThemeId } from '../palette/built-in-themes';
import { snapshotStockHalf } from '../palette/stock-palette';
import { freeThemeName, serializeThemeFile, type ThemeDefinition } from '../palette/theme-schema';

/**
 * A new custom theme starting from `theme`. Stock Frink is snapshotted from globals.css, which
 * reads the DOM: call from event handlers, never during render.
 */
export function themeCopy(
  theme: Theme,
  base: string,
  customThemes: readonly ThemeDefinition[],
): ThemeDefinition {
  const name = freeThemeName(
    base,
    customThemes.map((each) => each.name),
  );
  const halves = isStockTheme(theme)
    ? { light: snapshotStockHalf('light'), dark: snapshotStockHalf('dark') }
    : { light: theme.light, dark: theme.dark };
  return { id: uniqueThemeId(name, customThemes), name, ...halves };
}

/** Saves `theme` as `<id>.json` through the download flow. */
export function downloadThemeFile(theme: ThemeDefinition): void {
  const blob = new Blob([serializeThemeFile(theme)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${theme.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Runs a discrete theme or mode pick as one crossfade, unless motion is reduced. */
export function withViewTransition(update: () => void): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('startViewTransition' in document)) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}
