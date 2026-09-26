import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, isStockTheme } from './built-in-themes';
import { contrastRatio, toOklch } from './color';
import { AA_FLOOR, companionColor, derivePalette, quietText, solveLightness } from './derive';
import type { Role } from './roles';
import type { ThemeDefinition } from './theme-schema';

const HALVES = BUILT_IN_THEMES.filter(
  (theme): theme is ThemeDefinition => !isStockTheme(theme),
).flatMap((theme) =>
  (['light', 'dark'] as const).map((appearance) => ({
    label: `${theme.id} ${appearance}`,
    half: theme[appearance],
  })),
);

// Every place a foreground is read on a fill in Frink, including accent and error used as text.
const FLOORS: [foreground: Role, surface: Role, min: number][] = [
  ['text', 'background', 7],
  ['text', 'surface', 7],
  ['text', 'sidebar', 7],
  ['mutedText', 'background', 4.5],
  ['mutedText', 'sidebar', 4.5],
  ['mutedText', 'muted', 4.5],
  ['mutedText', 'highlightSurface', 4.5],
  ['accentForeground', 'accent', 4.5],
  ['accent', 'background', 4.5],
  ['subtleForeground', 'subtleSurface', 4.5],
  ['highlightForeground', 'highlightSurface', 4.5],
  ['destructive', 'background', 4.5],
  ['destructiveForeground', 'destructive', 4.5],
];

const hex = (channel: number): string => channel.toString(16).padStart(2, '0');
const CHANNELS = [0, 51, 102, 153, 204, 255];
// An RGB grid, the mid-grey band, and Nord / Dracula / gruvbox mid-dark canvases.
const ANY_BACKGROUND = [
  ...CHANNELS.flatMap((r) =>
    CHANNELS.flatMap((g) => CHANNELS.map((b) => `#${hex(r)}${hex(g)}${hex(b)}`)),
  ),
  ...[0x38, 0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70].map((v) => `#${hex(v).repeat(3)}`),
  '#3b4252',
  '#44475a',
  '#504945',
];
const ANY_ACCENT = ['#000000', '#ffffff', '#808080', '#ff0000', '#3b82f6'];
// The accent is a seed kept as given, so only derived foregrounds are held to a floor here.
const DERIVED_FLOORS = FLOORS.filter(([foreground]) => foreground !== 'accent');
const bestOf = (surface: string): number =>
  Math.max(contrastRatio('#000000', surface), contrastRatio('#ffffff', surface));

describe('derivePalette', () => {
  it('covers the ten non-stock built-in halves', () => {
    expect(HALVES).toHaveLength(10);
  });

  describe.each(HALVES)('$label', ({ half }) => {
    const palette = derivePalette(half);

    it('matches the pinned palette', () => {
      expect(palette).toMatchSnapshot();
    });

    it.each(FLOORS)('%s on %s clears %d:1', (foreground, surface, min) => {
      expect(contrastRatio(palette[foreground], palette[surface])).toBeGreaterThanOrEqual(min);
    });
  });

  it.each(ANY_BACKGROUND)('clears every floor it can for any seed on %s', (background) => {
    for (const accent of ANY_ACCENT) {
      const palette = derivePalette({ background, accent });
      for (const [foreground, surface, min] of DERIVED_FLOORS) {
        const floor = Math.min(min, bestOf(palette[surface])) - 0.01;
        expect(
          contrastRatio(palette[foreground], palette[surface]),
          `${foreground} on ${surface} with accent ${accent}`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('keeps body and button text readable on a Nord canvas', () => {
    const palette = derivePalette({ background: '#3b4252', accent: '#88c0d0' });
    expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(palette.subtleForeground, palette.subtleSurface)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('feeds an overridden role into the roles derived from it', () => {
    const plain = derivePalette({ background: '#ffffff', accent: '#1e754f' });
    const inked = derivePalette({
      background: '#ffffff',
      accent: '#1e754f',
      overrides: { text: '#393a34' },
    });
    expect(inked.text).toBe('#393a34');
    expect(inked.subtleForeground).toBe('#393a34');
    expect(inked.mutedText).not.toBe(plain.mutedText);
  });

  it('keeps the seeds as given', () => {
    const palette = derivePalette({
      background: '#1c1519',
      accent: '#ff8cc6',
      overrides: { border: '#123456' },
    });
    expect(palette).toMatchObject({
      background: '#1c1519',
      accent: '#ff8cc6',
      border: '#123456',
      input: '#123456',
    });
  });
});

describe('companionColor', () => {
  it('turns the accent hue 50°', () => {
    const accentHue = toOklch('#a78bfa').h ?? 0;
    const companionHue = toOklch(companionColor('#a78bfa', 'dark')).h ?? 0;
    expect(Math.abs(companionHue - ((accentHue + 50) % 360))).toBeLessThan(3);
  });
});

describe('solveLightness', () => {
  it('keeps a colour that already clears the floor', () => {
    expect(solveLightness(toOklch('#ffffff'), ['#000000'], AA_FLOOR, false)).toBe('#ffffff');
  });

  it('lightens only until the colour clears the floor on every surface', () => {
    const surfaces = ['#262624', '#000000'];
    const solved = solveLightness(toOklch('#1e3a8a'), surfaces, AA_FLOOR, true);
    const contrasts = surfaces.map((surface) => contrastRatio(solved, surface));
    expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(AA_FLOOR);
    expect(Math.min(...contrasts)).toBeLessThan(AA_FLOOR + 0.1);
  });
});

describe('quietText', () => {
  it('fades text toward the canvas only as far as every floor allows', () => {
    const surfaces = ['#faf9f5', '#f0eee6'];
    const quiet = quietText(
      '#141413',
      '#faf9f5',
      surfaces.map((surface): [string, number] => [surface, AA_FLOOR]),
    );
    const contrasts = surfaces.map((surface) => contrastRatio(quiet, surface));
    expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(AA_FLOOR);
    expect(Math.min(...contrasts)).toBeLessThan(AA_FLOOR + 0.1);
  });
});
