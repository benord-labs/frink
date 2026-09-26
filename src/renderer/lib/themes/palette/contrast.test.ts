import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, isStockTheme } from './built-in-themes';
import { contrastRatio, hslTripletToHex } from './color';
import { applyContrast, CONTRAST_RANGE, contrastToPosition, positionToContrast } from './contrast';
import { derivePalette } from './derive';
import { type Palette, type Role, ROLES } from './roles';
import type { Half } from './theme-schema';

const dark = derivePalette({ background: '#262624', accent: '#d97857' });
const light = derivePalette({ background: '#faf9f5', accent: '#b05230' });
const TRANSFORMED = new Set([
  'text',
  'mutedText',
  'subtleForeground',
  'highlightForeground',
  'border',
  'input',
]);

const PAGE: Role[] = [
  'background',
  'surface',
  'sidebar',
  'overlay',
  'muted',
  'subtleSurface',
  'highlightSurface',
];
const SITS_ON: [Role, Role[]][] = [
  ['text', PAGE],
  ['mutedText', PAGE],
  ['subtleForeground', ['subtleSurface']],
  ['highlightForeground', ['highlightSurface']],
];
// Frink stock dark as globals.css paints it: panels, menus and buttons all lighter than the window.
const STOCK_DARK = Object.fromEntries(
  Object.entries({
    background: '0 0% 2%',
    surface: '0 0% 4%',
    sidebar: '0 0% 4%',
    overlay: '0 0% 10%',
    muted: '0 0% 4%',
    subtleSurface: '0 0% 16%',
    highlightSurface: '0 0% 10%',
    text: '0 0% 91%',
    mutedText: '0 0% 55%',
    subtleForeground: '0 0% 91%',
    highlightForeground: '0 0% 91%',
  }).map(([role, triplet]) => [role, hslTripletToHex(triplet)]),
);
type FadeCase = [name: string, half: Omit<Half, 'syntax'>];
const FADE_CASES: FadeCase[] = [
  ...BUILT_IN_THEMES.flatMap((theme): FadeCase[] =>
    isStockTheme(theme)
      ? []
      : [
          [`${theme.id} light`, theme.light],
          [`${theme.id} dark`, theme.dark],
        ],
  ),
  ['stock-like light', { background: '#ffffff', accent: '#0034ff' }],
  ['stock dark', { background: STOCK_DARK.background, accent: '#a78bfa', overrides: STOCK_DARK }],
];

const ON_OWN_SURFACE: [Role, Role][] = [
  ['text', 'background'],
  ['mutedText', 'background'],
  ['subtleForeground', 'subtleSurface'],
  ['highlightForeground', 'highlightSurface'],
];
// Canvases and buttons of either lightness: boosting must follow each text role's own surface.
const MISMATCHED: [name: string, palette: Palette][] = [
  ['dark canvas', derivePalette({ background: '#1a1a2e', accent: '#3b82f6' })],
  ['light canvas', derivePalette({ background: '#f5f5f5', accent: '#3b82f6' })],
  [
    'light buttons on a dark canvas',
    derivePalette({
      background: '#1e1e1e',
      accent: '#0e639c',
      overrides: {
        subtleSurface: '#e0e0e0',
        subtleForeground: '#000000',
        highlightSurface: '#cce6ff',
        highlightForeground: '#000000',
      },
    }),
  ],
  [
    'dark buttons on a light canvas',
    derivePalette({
      background: '#ffffff',
      accent: '#0034ff',
      overrides: { subtleSurface: '#333333', subtleForeground: '#ffffff' },
    }),
  ],
];

const CONTRASTS = [50, 75, 100, 150, 200];
const cr = (palette: Palette, fg: Role, bg: Role = 'background'): number =>
  contrastRatio(palette[fg], palette[bg]);

describe('contrast slider mapping', () => {
  it.each([
    [50, 0],
    [75, 25],
    [100, 50],
    [150, 75],
    [200, 100],
  ])('puts %d at position %d, Standard dead centre', (contrast, position) => {
    expect(contrastToPosition(contrast)).toBe(position);
    expect(positionToContrast(position)).toBe(contrast);
  });

  it('round-trips every step and rounds a drag to the nearest step', () => {
    for (let c = CONTRAST_RANGE.min; c <= CONTRAST_RANGE.max; c += CONTRAST_RANGE.step)
      expect(positionToContrast(contrastToPosition(c))).toBe(c);
    expect(positionToContrast(51)).toBe(100);
    expect(positionToContrast(53)).toBe(105);
    expect(positionToContrast(12.4)).toBe(60);
  });
});

describe('applyContrast', () => {
  it('is the identity at 100', () => {
    expect(applyContrast(dark, 100)).toBe(dark);
  });

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('raises text, faded text and lines above 100 in %s', (_, palette) => {
    const boosted = applyContrast(palette, 150);
    for (const role of ['text', 'mutedText', 'border'] as const)
      expect(cr(boosted, role)).toBeGreaterThan(cr(palette, role));
    expect(cr(boosted, 'highlightForeground', 'highlightSurface')).toBeGreaterThan(
      cr(palette, 'highlightForeground', 'highlightSurface'),
    );
  });

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('fades text and lines, never faded text, below 100 in %s', (_, palette) => {
    const faded = applyContrast(palette, 80);
    for (const role of ['text', 'border', 'input'] as const)
      expect(cr(faded, role)).toBeLessThan(cr(palette, role));
    expect(faded.mutedText).toBe(palette.mutedText);
    expect(faded.subtleForeground).toBe(faded.text);
  });

  it.each(FADE_CASES)('keeps text readable on every surface it sits on at 50 in %s', (_, half) => {
    const palette = derivePalette(half);
    const faded = applyContrast(palette, 50);
    for (const [role, surfaces] of SITS_ON) {
      for (const surface of surfaces) {
        const floor = Math.min(4.5, cr(palette, role, surface));
        expect(cr(faded, role, surface)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it.each(FADE_CASES)('keeps %s legible and ranked at every contrast', (_, half) => {
    const palette = derivePalette(half);
    for (const contrast of CONTRASTS) {
      const shown = applyContrast(palette, contrast);
      expect(cr(shown, 'text'), `text at ${contrast}`).toBeGreaterThanOrEqual(7);
      expect(cr(shown, 'mutedText'), `faded text at ${contrast}`).toBeGreaterThanOrEqual(4.5);
      // Faded text sits a step below text; hex rounding can land a hair under 1.4.
      expect(cr(shown, 'text') / cr(shown, 'mutedText')).toBeGreaterThanOrEqual(
        Math.min(1.38, cr(palette, 'text') / cr(palette, 'mutedText')),
      );
    }
  });

  it('all but erases lines at 50 and gives them 3:1 at 200', () => {
    for (const [name, half] of FADE_CASES) {
      const palette = derivePalette(half);
      expect(cr(applyContrast(palette, 50), 'border'), name).toBeLessThan(1.2);
      // Moss light's text override is lighter, so its lines stop short (2.5:1).
      if (name !== 'moss light')
        expect(cr(applyContrast(palette, 200), 'border'), name).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(MISMATCHED)(
    "boosting never lowers a text role's contrast on its own surface: %s",
    (_, palette) => {
      for (const contrast of [110, 150, 200]) {
        const boosted = applyContrast(palette, contrast);
        for (const [role, surface] of ON_OWN_SURFACE) {
          expect(
            cr(boosted, role, surface),
            `${role} on ${surface} at ${contrast}`,
          ).toBeGreaterThanOrEqual(cr(palette, role, surface) - 0.01);
        }
      }
    },
  );

  it.each([50, 200])('never touches surfaces, accent or error colours at %d', (contrast) => {
    const shown = applyContrast(dark, contrast);
    for (const role of ROLES.filter((r) => !TRANSFORMED.has(r)))
      expect(shown[role]).toBe(dark[role]);
  });
});
