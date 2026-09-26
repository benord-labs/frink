import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_THEMES,
  FRINK_THEME,
  FRINK_THEME_ID,
  findTheme,
  isStockTheme,
  uniqueThemeId,
} from './built-in-themes';
import { type ThemeDefinition, ThemeDefinitionSchema } from './theme-schema';

const CUSTOM: ThemeDefinition = {
  id: 'my-theme',
  name: 'My theme',
  light: { background: '#ffffff', accent: '#0034ff', syntax: 'github-light' },
  dark: { background: '#050505', accent: '#a78bfa', syntax: 'github-dark' },
};

describe('BUILT_IN_THEMES', () => {
  it('has Frink stock plus five derived themes already in canonical stored form', () => {
    expect(BUILT_IN_THEMES.map((theme) => theme.id)).toEqual([
      FRINK_THEME_ID,
      'clay',
      'amber',
      'moss',
      'tide',
      'sprinkles',
    ]);
    const derived = BUILT_IN_THEMES.filter(
      (t): t is ThemeDefinition & { description?: string } => !isStockTheme(t),
    );
    for (const { description: _, ...theme } of derived) {
      expect(ThemeDefinitionSchema.parse(theme)).toEqual(theme);
    }
  });

  it('describes every built-in in one line', () => {
    for (const theme of BUILT_IN_THEMES) expect(theme.description).toMatch(/^[A-Z].+\.$/);
  });
});

describe('findTheme', () => {
  it('finds built-in and custom themes', () => {
    expect(findTheme('clay', []).name).toBe('Clay');
    expect(findTheme('my-theme', [CUSTOM])).toBe(CUSTOM);
  });

  it('falls back to Frink for an id that no longer resolves', () => {
    expect(findTheme('deleted-theme', [CUSTOM])).toBe(FRINK_THEME);
  });

  it('prefers a built-in over a custom theme with the same id', () => {
    expect(findTheme('clay', [{ ...CUSTOM, id: 'clay' }]).name).toBe('Clay');
  });
});

describe('uniqueThemeId', () => {
  it('slugs the name and avoids built-in and custom ids', () => {
    expect(uniqueThemeId('Sunset Glow!', [])).toBe('sunset-glow');
    expect(uniqueThemeId('My theme', [CUSTOM])).toBe('my-theme-2');
    expect(uniqueThemeId('Clay', [])).toBe('clay-2');
    expect(uniqueThemeId('✨', [])).toBe('theme');
  });
});
