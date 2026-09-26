import { describe, expect, it } from 'vitest';
import { FRINK_THEME, findTheme } from '../palette/built-in-themes';
import { derivePalette } from '../palette/derive';
import type { ThemeDefinition } from '../palette/theme-schema';
import { themeHalfPalette, withAlpha } from './theme-palette';

const STOCK = {
  light: derivePalette({ background: '#ffffff', accent: '#0034ff' }),
  dark: derivePalette({ background: '#050505', accent: '#a78bfa' }),
};

describe('themeHalfPalette', () => {
  it('shows stock Frink as globals.css paints it, and nothing until that is read', () => {
    expect(themeHalfPalette(FRINK_THEME, 'dark', STOCK)).toBe(STOCK.dark);
    expect(themeHalfPalette(FRINK_THEME, 'dark', null)).toBeNull();
  });

  it('derives every other half from its seeds, once per half', () => {
    const clay = findTheme('clay', []);
    const light = themeHalfPalette(clay, 'light', null);
    expect(light).toEqual(derivePalette({ background: '#faf9f5', accent: '#b05230' }));
    expect(themeHalfPalette(clay, 'light', null)).toBe(light);
  });

  it('re-derives a theme saved under the same id with new colours', () => {
    const mine: ThemeDefinition = {
      id: 'mine',
      name: 'Mine',
      light: { background: '#ffffff', accent: '#2b6878', syntax: 'min-light' },
      dark: { background: '#1f1f1f', accent: '#86b3c2', syntax: 'min-dark' },
    };
    const edited = { ...mine, dark: { ...mine.dark, accent: '#ff8cc6' } };
    expect(themeHalfPalette(edited, 'dark', null)?.accent).toBe('#ff8cc6');
    expect(themeHalfPalette(mine, 'dark', null)?.accent).toBe('#86b3c2');
  });
});

describe('withAlpha', () => {
  it('mixes a colour toward transparent at the given opacity', () => {
    expect(withAlpha('#0034ff', '70%')).toBe('color-mix(in srgb, #0034ff 70%, transparent)');
  });
});
