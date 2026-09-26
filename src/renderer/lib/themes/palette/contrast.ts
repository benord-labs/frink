import { contrastRatio, mixOklab } from './color';
import { AA_FLOOR, quietText } from './derive';
import type { Palette, Role } from './roles';

/** Contrast slider range, in percent. 100 (Standard) leaves the palette untouched. */
export const CONTRAST_RANGE = { min: 50, max: 200, step: 5, default: 100 } as const;

/** Contrast → slider position (0–100). Standard sits dead centre: 50–100 fills the left half, 100–200 the right. */
export function contrastToPosition(contrast: number): number {
  return contrast <= 100 ? contrast - 50 : 50 + (contrast - 100) / 2;
}

/** Slider position (0–100) → contrast, rounded to the range's step. */
export function positionToContrast(position: number): number {
  const contrast = position <= 50 ? 50 + position : 100 + (position - 50) * 2;
  return Math.round(contrast / CONTRAST_RANGE.step) * CONTRAST_RANGE.step;
}

// Every surface body text sits on: panels, menus, buttons and hover rows as well as the window.
const PAGE_SURFACES: readonly Role[] = [
  'background',
  'surface',
  'sidebar',
  'overlay',
  'muted',
  'subtleSurface',
  'highlightSurface',
];
const BORDER_ROLES: readonly Role[] = ['border', 'input'];
// Text and the foregrounds on buttons and hover rows, each boosted away from its own surface.
const BOOSTED: readonly [text: Role, surface: Role][] = [
  ['text', 'background'],
  ['subtleForeground', 'subtleSurface'],
  ['highlightForeground', 'highlightSurface'],
];
// Softer: lines keep 25% of their distance from the window, text mixes up to 25% toward it.
const LINE_FADE = 0.75;
const TEXT_FADE = 0.25;
// Sharper: faded text moves at half the text rate, lines up to 35% of the way to text.
const MUTED_BOOST = 0.5;
const LINE_BOOST = 0.35;
// Body text never drops below AAA on the window, and stays this much above faded text.
const TEXT_FLOOR = 7;
const HIERARCHY = 1.4;

/** White for text lighter than its surface, black for text darker: the way that adds contrast. */
function awayFrom(text: string, surface: string): string {
  return contrastRatio(text, '#000000') >= contrastRatio(surface, '#000000')
    ? '#ffffff'
    : '#000000';
}

/** Lines carry the change; text fades gently, floored so it stays readable and above faded text. */
function soften(palette: Palette, k: number): Palette {
  const { background, text, mutedText } = palette;
  const windowFloor = Math.min(
    contrastRatio(text, background),
    Math.max(TEXT_FLOOR, HIERARCHY * contrastRatio(mutedText, background)),
  );
  const floors = PAGE_SURFACES.map((role): [string, number] => [
    palette[role],
    role === 'background' ? windowFloor : Math.min(AA_FLOOR, contrastRatio(text, palette[role])),
  ]);
  const faded = mixOklab(text, background, k * TEXT_FADE);
  const softText = floors.every(([surface, min]) => contrastRatio(faded, surface) >= min)
    ? faded
    : quietText(text, background, floors);
  const result = { ...palette, text: softText };
  for (const role of ['subtleForeground', 'highlightForeground'] as const)
    if (palette[role] === text) result[role] = softText;
  for (const role of BORDER_ROLES)
    result[role] = mixOklab(palette[role], background, k * LINE_FADE);
  return result;
}

/** Text moves toward white or black; faded text follows at half rate, a step below text. */
function sharpen(palette: Palette, k: number): Palette {
  const result = { ...palette };
  for (const [role, surface] of BOOSTED)
    result[role] = mixOklab(palette[role], awayFrom(palette[role], palette[surface]), k);
  const { background, mutedText } = palette;
  const cap = contrastRatio(result.text, background) / HIERARCHY;
  const muted = mixOklab(mutedText, awayFrom(mutedText, background), k * MUTED_BOOST);
  if (contrastRatio(mutedText, background) >= cap) result.mutedText = mutedText;
  else if (contrastRatio(muted, background) <= cap) result.mutedText = muted;
  else result.mutedText = quietText(muted, background, [[background, cap]]);
  for (const role of BORDER_ROLES)
    result[role] = mixOklab(palette[role], palette.text, k * LINE_BOOST);
  return result;
}

/**
 * Softer (below 100) fades lines and text, never faded text; Sharper (above 100) pushes text,
 * faded text and lines apart from their surfaces. Surfaces, accent and error never change.
 */
export function applyContrast(palette: Palette, contrast: number): Palette {
  if (contrast === CONTRAST_RANGE.default) return palette;
  return contrast < 100
    ? soften(palette, (100 - contrast) / 50)
    : sharpen(palette, (contrast - 100) / 100);
}
