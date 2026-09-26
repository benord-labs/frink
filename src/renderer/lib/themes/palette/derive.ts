import type { Oklch } from 'culori/fn';
import { contrastRatio, isDarkColor, mixOklab, oklchHex, toOklch } from './color';
import type { Appearance, Palette, Role } from './roles';
import type { Half } from './theme-schema';

type Seeds = Pick<Half, 'background' | 'accent' | 'overrides'>;
type Lch = { l: number; c: number; h?: number };

// OKLCH lightness step away from the canvas, fitted to Frink's globals.css elevation system:
// steep in dark, nearly flat in light (card and popover are the canvas).
const RAMP = {
  sidebar: { dark: 0.03, light: 0.015 },
  surface: { dark: 0.076, light: 0 },
  overlay: { dark: 0.103, light: 0 },
  field: { dark: 0.103, light: 0.033 },
  muted: { dark: 0.103, light: 0.033 },
  highlightSurface: { dark: 0.124, light: 0.033 },
  subtleSurface: { dark: 0.162, light: 0.033 },
  border: { dark: 0.182, light: 0.08 },
} as const satisfies Partial<Record<Role, Record<Appearance, number>>>;

// Surfaces keep the canvas hue; chroma is capped so a tinted canvas stays a tint.
const MAX_SURFACE_CHROMA = 0.045;
// Frink's stock status reds; hue kept, lightness solved per theme.
const DESTRUCTIVE = { dark: '#f7a1a1', light: '#dc2626' };
// Contrast of Frink's stock muted text on its canvas.
const MUTED_TARGET = { dark: 5.98, light: 5.2 };
const TEXT_FLOOR = 7;
// The contrast at which black and white read equally on a fill (√21).
const MID_GREY = Math.sqrt(21);
// WCAG AA (4.5) plus headroom for the browser's colour conversion.
export const AA_FLOOR = 4.6;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Binary-search OKLCH lightness (toward white when `lighter`) until every contrast holds. */
export function solveLightness(
  base: Lch,
  against: string[],
  min: number,
  lighter: boolean,
): string {
  const passes = (l: number): boolean =>
    against.every((bg) => contrastRatio(oklchHex(l, base.c, base.h), bg) >= min);
  if (passes(base.l)) return oklchHex(base.l, base.c, base.h);
  let lo = lighter ? base.l : 0;
  let hi = lighter ? 1 : base.l;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (passes(mid) === lighter) hi = mid;
    else lo = mid;
  }
  return oklchHex(lighter ? hi : lo, base.c, base.h);
}

/** Quietest OKLab mix of text toward the canvas that still clears every floor. */
export function quietText(
  text: string,
  canvas: string,
  floors: [surface: string, min: number][],
): string {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    const color = mixOklab(text, canvas, mid);
    if (floors.every(([surface, min]) => contrastRatio(color, surface) >= min)) lo = mid;
    else hi = mid;
  }
  return mixOklab(text, canvas, lo);
}

/** The theme's own canvas or text when either reads on the fill, else black or white. */
function readableOn(fill: string, candidates: string[]): string {
  const best = candidates.reduce((a, b) =>
    contrastRatio(b, fill) > contrastRatio(a, fill) ? b : a,
  );
  if (contrastRatio(best, fill) >= AA_FLOOR) return best;
  return contrastRatio('#ffffff', fill) >= contrastRatio('#000000', fill) ? '#ffffff' : '#000000';
}

/**
 * A surface `step` of OKLCH lightness away from the canvas, in the canvas hue, held on the
 * canvas's side of mid-grey so the text colour that reads on the canvas still reads on it.
 */
function rampColor(canvas: Oklch, appearance: Appearance, step: number): string {
  const dark = appearance === 'dark';
  const l = clamp(canvas.l + (dark ? step : -step), 0.05, 1);
  const base = { l, c: Math.min(canvas.c, MAX_SURFACE_CHROMA), h: canvas.h };
  return solveLightness(base, [dark ? '#ffffff' : '#000000'], MID_GREY, !dark);
}

/**
 * Background + Accent → every role. Overrides apply in dependency order, so an overridden
 * role (e.g. text) still feeds the roles derived from it. Pure but not cheap: keep it out of render.
 */
export function derivePalette({ background, accent, overrides: o = {} }: Seeds): Palette {
  const canvas = toOklch(background);
  const appearance: Appearance = isDarkColor(background) ? 'dark' : 'light';
  const dark = appearance === 'dark';
  const ramp = (role: keyof typeof RAMP): string =>
    o[role] ?? rampColor(canvas, appearance, RAMP[role][appearance]);
  const surface = ramp('surface');
  const sidebar = ramp('sidebar');
  const overlay = ramp('overlay');
  const muted = ramp('muted');
  const subtleSurface = ramp('subtleSurface');
  const highlightSurface = ramp('highlightSurface');
  const border = ramp('border');
  const textBase = { l: dark ? 0.93 : 0.14, c: Math.min(canvas.c, 0.02), h: canvas.h };
  const text = o.text ?? solveLightness(textBase, [background, surface, sidebar], TEXT_FLOOR, dark);
  // One --muted-foreground sits on the canvas, soft fills and hover rows alike.
  const mutedText =
    o.mutedText ??
    quietText(text, background, [
      [background, MUTED_TARGET[appearance]],
      [muted, AA_FLOOR],
      [highlightSurface, AA_FLOOR],
    ]);
  const destructiveBase = toOklch(DESTRUCTIVE[appearance]);
  const destructive =
    o.destructive ?? solveLightness(destructiveBase, [background, overlay], AA_FLOOR, dark);
  return {
    background,
    surface,
    sidebar,
    overlay,
    field: ramp('field'),
    muted,
    subtleSurface,
    highlightSurface,
    text,
    mutedText,
    subtleForeground: o.subtleForeground ?? text,
    highlightForeground: o.highlightForeground ?? text,
    accent,
    accentForeground: o.accentForeground ?? readableOn(accent, [background, text]),
    border,
    input: o.input ?? border,
    destructive,
    destructiveForeground: o.destructiveForeground ?? readableOn(destructive, [background, text]),
  };
}

/** Second hue of the chat atmosphere's floor and the bench's code bars (not a role): accent + 50°. */
export function companionColor(accent: string, appearance: Appearance): string {
  const { l, c, h = 0 } = toOklch(accent);
  const lightness = clamp(l + (appearance === 'dark' ? 0.06 : -0.02), 0.35, 0.85);
  return oklchHex(lightness, Math.max(c * 0.9, 0.06), (h + 50) % 360);
}
