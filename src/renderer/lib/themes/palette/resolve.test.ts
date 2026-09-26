// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './color';
import { applyContrast } from './contrast';
import { derivePalette } from './derive';
import { installStockSheet } from '../stock-sheet-fixture';
import { resolveActivePalette } from './resolve';
import type { ThemeDefinition } from './theme-schema';

const STOCK = installStockSheet();

const CUSTOM: ThemeDefinition = {
  id: 'my-theme',
  name: 'My theme',
  light: { background: '#fff7fa', accent: '#bc2b72', syntax: 'rose-pine-dawn' },
  dark: { background: '#1c1519', accent: '#ff8cc6', syntax: 'rose-pine-moon' },
};
const resolve = (light: string, dark: string, appearance: 'light' | 'dark', contrast = 100) =>
  resolveActivePalette({ halves: { light, dark }, customThemes: [CUSTOM], appearance, contrast });

describe('resolveActivePalette', () => {
  it('derives the half for the current appearance', () => {
    const mossDark = { background: '#121212', accent: '#4d9375', overrides: { text: '#dbd7ca' } };
    expect(resolve('clay', 'moss', 'dark')).toEqual({
      themeId: 'moss',
      appearance: 'dark',
      syntax: 'vitesse-dark',
      colors: derivePalette(mossDark),
      stock: false,
      inline: true,
    });
  });

  it('resolves custom themes and applies contrast', () => {
    const active = resolve('my-theme', 'frink', 'light', 130);
    expect(active.syntax).toBe('rose-pine-dawn');
    expect(active.colors).toEqual(applyContrast(derivePalette(CUSTOM.light), 130));
  });

  it('leaves stock to globals.css at contrast 100 but still reports its colours', () => {
    expect(resolve('clay', 'frink', 'dark')).toMatchObject({
      themeId: 'frink',
      stock: true,
      inline: false,
      colors: STOCK.dark,
    });
  });

  it('writes stock inline once contrast changes it', () => {
    const active = resolve('frink', 'frink', 'light', 120);
    expect(active).toMatchObject({ stock: true, inline: true, syntax: 'github-light' });
    expect(active.colors).toEqual(applyContrast(STOCK.light, 120));
  });

  it('raises contrast on a light half painted with a dark canvas', () => {
    const nightOnly: ThemeDefinition = {
      ...CUSTOM,
      id: 'night-only',
      light: { ...CUSTOM.dark, background: '#1a1a2e' },
    };
    const at = (contrast: number) =>
      resolveActivePalette({
        halves: { light: 'night-only', dark: 'frink' },
        customThemes: [nightOnly],
        appearance: 'light',
        contrast,
      }).colors;
    const plain = at(100);
    const boosted = at(150);
    expect(contrastRatio(boosted.text, boosted.background)).toBeGreaterThan(
      contrastRatio(plain.text, plain.background),
    );
  });

  it('falls back to Frink when a half points at a deleted theme', () => {
    expect(resolve('deleted', 'frink', 'light').themeId).toBe('frink');
  });
});
