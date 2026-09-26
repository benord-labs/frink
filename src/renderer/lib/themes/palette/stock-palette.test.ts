// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hslTripletToHex } from './color';
import { ROLE_VARS, ROLES } from './roles';
import { getStockPalette, snapshotStockHalf } from './stock-palette';

// Stand-in for globals.css: a distinct triplet per role and appearance.
const triplet = (index: number, appearance: 'light' | 'dark'): string =>
  `${index * 19} ${appearance === 'light' ? 60 : 40}% ${appearance === 'light' ? 70 : 20}%`;
const block = (appearance: 'light' | 'dark'): string =>
  ROLES.map((role, i) => `${ROLE_VARS[role][0]}: ${triplet(i, appearance)};`).join('');
const expected = (appearance: 'light' | 'dark') =>
  Object.fromEntries(ROLES.map((role, i) => [role, hslTripletToHex(triplet(i, appearance))]));

const sheet = document.createElement('style');
beforeAll(() => {
  sheet.textContent = `:root{${block('light')}} .dark{${block('dark')}}`;
  document.head.append(sheet);
});
afterAll(() => sheet.remove());

describe('getStockPalette', () => {
  it('reads the other appearance under an inline theme and restores <html> exactly', () => {
    const html = document.documentElement;
    html.className = 'light';
    html.setAttribute('style', '--background: 1 2% 3%; --glass-opacity: 70%;');

    expect(getStockPalette('dark')).toEqual(expected('dark'));
    expect(getStockPalette('light')).toEqual(expected('light'));
    expect(html.className).toBe('light');
    expect(html.getAttribute('style')).toBe('--background: 1 2% 3%; --glass-opacity: 70%;');
  });

  it('restores <html> even when a stock var cannot be read', async () => {
    vi.resetModules();
    const { getStockPalette: readFresh } = await import('./stock-palette');
    const html = document.documentElement;
    html.className = 'light';
    html.setAttribute('style', '--glass-opacity: 70%;');
    const css = sheet.textContent;
    sheet.textContent = '';

    try {
      expect(() => readFresh('dark')).toThrow();
    } finally {
      sheet.textContent = css;
    }
    expect(html.className).toBe('light');
    expect(html.getAttribute('style')).toBe('--glass-opacity: 70%;');
  });
});

describe('snapshotStockHalf', () => {
  it('seeds from background + accent and pins every other role as an override', () => {
    const { background, accent, ...rest } = expected('light');
    expect(snapshotStockHalf('light')).toEqual({
      background,
      accent,
      overrides: rest,
      syntax: 'github-light',
    });
  });
});
