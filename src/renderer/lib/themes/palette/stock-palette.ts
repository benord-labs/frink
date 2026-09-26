import { THEME_SWITCHING_CLASS } from './apply';
import { FRINK_THEME } from './built-in-themes';
import { hslTripletToHex } from './color';
import { type Appearance, type Palette, ROLE_VARS, ROLES } from './roles';
import type { Half } from './theme-schema';

// globals.css is static for the session, so each appearance is read once.
const cache: Partial<Record<Appearance, Palette>> = {};

/**
 * Reads globals.css's stock values for `appearance` in one synchronous task: inline styles off,
 * `.dark` set for the target, computed vars read, everything restored before the next paint.
 */
function readStockPalette(appearance: Appearance): Palette {
  const html = document.documentElement;
  const className = html.className;
  const style = html.getAttribute('style');
  html.classList.add(THEME_SWITCHING_CLASS);
  html.classList.toggle('dark', appearance === 'dark');
  html.classList.toggle('light', appearance === 'light');
  html.removeAttribute('style');
  try {
    const computed = getComputedStyle(html);
    // SAFETY: one entry per role in ROLES, which is exactly the Palette key set.
    return Object.fromEntries(
      ROLES.map((role) => [role, hslTripletToHex(computed.getPropertyValue(ROLE_VARS[role][0]))]),
    ) as Palette;
  } finally {
    html.className = className;
    html.classList.add(THEME_SWITCHING_CLASS);
    if (style === null) html.removeAttribute('style');
    else html.setAttribute('style', style);
    // Recalc with transitions still off, so lifting the class animates nothing.
    getComputedStyle(html).getPropertyValue('--background');
    html.className = className;
  }
}

/** Frink stock palette as globals.css paints it. Touches the DOM: never call during render. */
export function getStockPalette(appearance: Appearance): Palette {
  cache[appearance] ??= readStockPalette(appearance);
  return cache[appearance];
}

/** Stock as an editable half: seeds are background + accent, every other role an override. */
export function snapshotStockHalf(appearance: Appearance): Half {
  const { background, accent, ...overrides } = getStockPalette(appearance);
  return { background, accent, overrides, syntax: FRINK_THEME[appearance].syntax };
}
