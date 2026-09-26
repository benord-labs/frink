import type { ActivePalette } from './apply';
import { findTheme, isStockTheme } from './built-in-themes';
import { applyContrast, CONTRAST_RANGE } from './contrast';
import { derivePalette } from './derive';
import type { Appearance } from './roles';
import { getStockPalette } from './stock-palette';
import type { ThemeDefinition } from './theme-schema';

/** Theme id per appearance; a row click sets both, a strip click one. */
export type ThemeHalves = Record<Appearance, string>;

/**
 * What to paint for `appearance`. Reads the DOM for stock Frink (via getStockPalette), so call it
 * from effects or boot code, never during render.
 */
export function resolveActivePalette({
  halves,
  customThemes,
  appearance,
  contrast,
}: {
  halves: ThemeHalves;
  customThemes: readonly ThemeDefinition[];
  appearance: Appearance;
  contrast: number;
}): ActivePalette {
  const theme = findTheme(halves[appearance], customThemes);
  const stock = isStockTheme(theme);
  const base = stock ? getStockPalette(appearance) : derivePalette(theme[appearance]);
  return {
    themeId: theme.id,
    appearance,
    syntax: theme[appearance].syntax,
    colors: applyContrast(base, contrast),
    stock,
    inline: !stock || contrast !== CONTRAST_RANGE.default,
  };
}
