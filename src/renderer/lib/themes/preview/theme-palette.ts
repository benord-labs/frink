import { isStockTheme, type Theme } from '../palette/built-in-themes';
import { derivePalette } from '../palette/derive';
import type { Appearance, Palette } from '../palette/roles';
import type { Half } from '../palette/theme-schema';

// Themes are replaced, never mutated, so each half object keys its palette.
const derived = new WeakMap<Half, Palette>();

/**
 * One half of `theme` in its own colours at contrast 100, derived the way `resolveActivePalette`
 * derives it. Stock Frink comes from `stock` (read from globals.css), so it is null until then.
 */
export function themeHalfPalette(
  theme: Theme,
  appearance: Appearance,
  stock: Record<Appearance, Palette> | null,
): Palette | null {
  if (isStockTheme(theme)) return stock?.[appearance] ?? null;
  const half = theme[appearance];
  let palette = derived.get(half);
  if (!palette) {
    palette = derivePalette(half);
    derived.set(half, palette);
  }
  return palette;
}

/** Preview paint: `color` at `percent` opacity, any CSS percentage such as `'70%'`. */
export function withAlpha(color: string, percent: string): string {
  return `color-mix(in srgb, ${color} ${percent}, transparent)`;
}
