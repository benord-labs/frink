import { describe, expect, it } from 'vitest';
import type { ActivePalette } from './palette/apply';
import { contrastRatio } from './palette/color';
import { derivePalette } from './palette/derive';
import { getTerminalTheme, TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from './terminal-theme';

const colors = derivePalette({ background: '#262624', accent: '#d97857' });
const clay: ActivePalette = {
  themeId: 'clay',
  appearance: 'dark',
  syntax: 'github-dark',
  colors,
  stock: false,
  inline: true,
};

describe('getTerminalTheme', () => {
  it("keeps Frink's own terminal colours until a palette is written inline", () => {
    expect(getTerminalTheme(true, null)).toBe(TERMINAL_THEME_DARK);
    expect(getTerminalTheme(true, { ...clay, stock: true, inline: false })).toBe(
      TERMINAL_THEME_DARK,
    );
  });

  it("paints the panel from the palette and keeps Frink's ANSI set", () => {
    const theme = getTerminalTheme(true, clay);

    expect(theme).toMatchObject({
      background: colors.sidebar,
      foreground: colors.text,
      cursor: colors.accent,
      cursorAccent: colors.sidebar,
      red: TERMINAL_THEME_DARK.red,
    });
    expect(contrastRatio(theme.selectionBackground ?? '', colors.sidebar)).toBeLessThan(
      contrastRatio(colors.accent, colors.sidebar),
    );
  });

  it("takes the ANSI set from the palette's appearance, not the app's", () => {
    const light = { ...clay, appearance: 'light' as const };

    expect(getTerminalTheme(true, light).red).toBe(TERMINAL_THEME_LIGHT.red);
    expect(getTerminalTheme(true, { ...light, stock: true, inline: false })).toBe(
      TERMINAL_THEME_LIGHT,
    );
  });
});
