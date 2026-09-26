import { describe, expect, it } from 'vitest';
import { BUILT_IN_THEMES, isStockTheme } from './built-in-themes';
import { hexToHslTriplet, hexToRgbTriplet, hslTripletToHex, mixOklab, toHex } from './color';
import { derivePalette } from './derive';

describe('HSL triplets', () => {
  it('formats with one decimal', () => {
    expect(hexToHslTriplet('#a78bfa')).toBe('255.1 91.7% 76.3%');
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
  });

  it('round-trips every colour of every built-in palette exactly', () => {
    const colors = BUILT_IN_THEMES.flatMap((theme) =>
      isStockTheme(theme)
        ? []
        : [theme.light, theme.dark].flatMap((half) => Object.values(derivePalette(half))),
    );
    expect(colors.length).toBeGreaterThan(100);
    for (const hex of colors) expect(hslTripletToHex(hexToHslTriplet(hex))).toBe(hex);
  });

  it('reads computed-style whitespace', () => {
    expect(hslTripletToHex(' 0 0% 100%')).toBe('#ffffff');
  });
});

describe('toHex', () => {
  it('canonicalises any CSS colour and rejects the rest', () => {
    expect(toHex('#FFF')).toBe('#ffffff');
    expect(toHex('rgb(255 0 0)')).toBe('#ff0000');
    expect(toHex('not a colour')).toBeUndefined();
  });
});

describe('mixOklab', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mixOklab('#101010', '#ffc799', 0)).toBe('#101010');
    expect(mixOklab('#101010', '#ffc799', 1)).toBe('#ffc799');
  });
});

describe('hexToRgbTriplet', () => {
  it('writes 0–255 channels', () => {
    expect(hexToRgbTriplet('#a78bfa')).toBe('167 139 250');
  });
});
