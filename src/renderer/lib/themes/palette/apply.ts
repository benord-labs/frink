import type { BundledTheme } from 'shiki/themes';
import { hexToHslTriplet, hexToRgbTriplet } from './color';
import { companionColor } from './derive';
import { glassVars } from './glass';
import { type Appearance, type Palette, ROLE_VARS, ROLES } from './roles';

/** Held on <html> while colours change so no transition animates the switch. */
export const THEME_SWITCHING_CLASS = 'theme-switching';

const SELECTION_VAR = '--selection';
// index.html's loader colour; PageLoader reuses it for every lazy page.
const LOADING_BG_VAR = '--loading-bg';
// The chat atmosphere's floor glow; stock keeps globals.css's marketing green.
const ATMOSPHERE_VAR = '--chat-atmosphere-floor';

let painted: ActivePalette | null = null;

/** The palette painted for one appearance, as `resolveActivePalette` returns it. */
export type ActivePalette = {
  themeId: string;
  appearance: Appearance;
  syntax: BundledTheme;
  /** What is on screen, contrast included; for stock, read from globals.css. */
  colors: Palette;
  /** Frink stock: globals.css keeps the loader colour and every unwritten var. */
  stock: boolean;
  /** False only for stock at contrast 100, where no role var is written inline. */
  inline: boolean;
};

function removeRoleVars(style: CSSStyleDeclaration): void {
  for (const role of ROLES) for (const name of ROLE_VARS[role]) style.removeProperty(name);
  style.removeProperty(SELECTION_VAR);
}

function setVars(style: CSSStyleDeclaration, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
}

/** The palette object last painted on <html>, or null once cleared. */
export function paintedPalette(): ActivePalette | null {
  return painted;
}

/** Paints `palette` on <html> (the vars must live there for @theme tokens to resolve). */
export function applyPalette(palette: ActivePalette): void {
  const html = document.documentElement;
  painted = palette;
  html.dataset.themeId = palette.themeId;
  if (palette.inline) {
    for (const role of ROLES) {
      const triplet = hexToHslTriplet(palette.colors[role]);
      for (const name of ROLE_VARS[role]) html.style.setProperty(name, triplet);
    }
    html.style.setProperty(SELECTION_VAR, `${hexToHslTriplet(palette.colors.accent)} / 0.25`);
  } else {
    removeRoleVars(html.style);
  }
  if (palette.stock) {
    html.style.removeProperty(ATMOSPHERE_VAR);
    html.style.removeProperty(LOADING_BG_VAR);
  } else {
    const floor = companionColor(palette.colors.accent, palette.appearance);
    html.style.setProperty(ATMOSPHERE_VAR, hexToRgbTriplet(floor));
    html.style.setProperty(LOADING_BG_VAR, palette.colors.background);
  }
}

/** Returns <html> to globals.css's stock palette. */
export function clearPalette(): void {
  const html = document.documentElement;
  painted = null;
  removeRoleVars(html.style);
  html.style.removeProperty(ATMOSPHERE_VAR);
  html.style.removeProperty(LOADING_BG_VAR);
  delete html.dataset.themeId;
}

export function applyGlass(level: number, appearance: Appearance): void {
  setVars(document.documentElement.style, glassVars(level, appearance));
}
