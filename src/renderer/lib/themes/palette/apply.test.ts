// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { type ActivePalette, applyGlass, applyPalette, clearPalette } from './apply';
import { hexToHslTriplet, hexToRgbTriplet } from './color';
import { companionColor, derivePalette } from './derive';

const colors = derivePalette({ background: '#262624', accent: '#d97857' });
const clay: ActivePalette = {
  themeId: 'clay',
  appearance: 'dark',
  syntax: 'github-dark',
  colors,
  stock: false,
  inline: true,
};
const html = document.documentElement;
const inline = (name: string): string => html.style.getPropertyValue(name);

beforeEach(() => {
  html.removeAttribute('style');
  delete html.dataset.themeId;
});

describe('applyPalette', () => {
  it("writes every role var, selection, the atmosphere floor and the loader's colour on <html>", () => {
    applyPalette(clay);
    expect(html.dataset.themeId).toBe('clay');
    expect(inline('--background')).toBe(hexToHslTriplet(colors.background));
    expect(inline('--card-foreground')).toBe(hexToHslTriplet(colors.text));
    expect(inline('--ring')).toBe(hexToHslTriplet(colors.accent));
    expect(inline('--selection')).toBe(`${hexToHslTriplet(colors.accent)} / 0.25`);
    expect(inline('--chat-atmosphere-floor')).toBe(
      hexToRgbTriplet(companionColor(colors.accent, 'dark')),
    );
    expect(inline('--loading-bg')).toBe(colors.background);
  });

  it('hands stock colours and its atmosphere at contrast 100 back to globals.css', () => {
    applyPalette(clay);
    applyPalette({ ...clay, themeId: 'frink', stock: true, inline: false });
    expect(html.dataset.themeId).toBe('frink');
    expect(inline('--background')).toBe('');
    expect(inline('--selection')).toBe('');
    expect(inline('--loading-bg')).toBe('');
    expect(inline('--chat-atmosphere-floor')).toBe('');
  });

  it('writes stock under a contrast change but leaves its loader colour alone', () => {
    applyPalette({ ...clay, themeId: 'frink', stock: true, inline: true });
    expect(inline('--foreground')).toBe(hexToHslTriplet(colors.text));
    expect(inline('--loading-bg')).toBe('');
  });
});

describe('clearPalette', () => {
  it('removes everything applyPalette wrote but leaves glass alone', () => {
    applyGlass(75, 'dark');
    applyPalette(clay);
    clearPalette();
    expect(html.dataset.themeId).toBeUndefined();
    expect(inline('--background')).toBe('');
    expect(inline('--selection')).toBe('');
    expect(inline('--chat-atmosphere-floor')).toBe('');
    expect(inline('--loading-bg')).toBe('');
    expect(inline('--glass-opacity')).toBe('55%');
  });
});
