import { describe, expect, it } from 'vitest';
import {
  freeThemeName,
  MAX_THEME_NAME_LENGTH,
  parseStoredThemes,
  serializeThemeFile,
  type ThemeDefinition,
  ThemeFileSchema,
} from './theme-schema';

const THEME: ThemeDefinition = {
  id: 'my-theme',
  name: 'My theme',
  light: { background: '#ffffff', accent: '#1e754f', syntax: 'vitesse-light' },
  dark: {
    background: '#121212',
    accent: '#4d9375',
    overrides: { text: '#dbd7ca' },
    syntax: 'vitesse-dark',
  },
};

describe('parseStoredThemes', () => {
  it('treats nothing stored as an empty, writable library', () => {
    expect(parseStoredThemes(null)).toEqual({ status: 'ready', themes: [] });
  });

  it('decodes stored themes', () => {
    expect(parseStoredThemes(JSON.stringify([THEME]))).toEqual({
      status: 'ready',
      themes: [THEME],
    });
  });

  it.each([
    ['malformed JSON', '[{"id":'],
    ['a non-array', '{"id":"my-theme"}'],
    ['a theme missing a half', JSON.stringify([{ ...THEME, dark: undefined }])],
    ['an invalid id', JSON.stringify([{ ...THEME, id: 'My Theme' }])],
  ])('is unavailable for %s', (_label, raw) => {
    expect(parseStoredThemes(raw)).toEqual({ status: 'unavailable' });
  });

  it('drops unknown roles and unparseable colours, canonicalising the rest', () => {
    const stored = {
      ...THEME,
      light: { ...THEME.light, overrides: { text: '#FFF', glow: '#123456', muted: 'nope' } },
    };
    const library = parseStoredThemes(JSON.stringify([stored]));
    expect(library.status === 'ready' && library.themes[0].light.overrides).toEqual({
      text: '#ffffff',
    });
  });

  it('falls back to the default syntax for an unknown Shiki theme', () => {
    const stored = { ...THEME, dark: { ...THEME.dark, syntax: 'retired-theme' } };
    const library = parseStoredThemes(JSON.stringify([stored]));
    expect(library.status === 'ready' && library.themes[0].dark.syntax).toBe('github-dark');
  });
});

describe('theme files', () => {
  it('round-trips through serializeThemeFile', () => {
    expect(ThemeFileSchema.parse(JSON.parse(serializeThemeFile(THEME)))).toEqual({
      version: 1,
      ...THEME,
    });
  });

  it('accepts a hand-written file without an id and rejects other versions', () => {
    const { id: _id, ...unnamed } = THEME;
    expect(ThemeFileSchema.safeParse({ version: 1, ...unnamed }).success).toBe(true);
    expect(ThemeFileSchema.safeParse({ version: 2, ...THEME }).success).toBe(false);
  });
});

describe('freeThemeName', () => {
  it('numbers a name past taken names, ignoring case', () => {
    expect(freeThemeName('Mine', [])).toBe('Mine');
    expect(freeThemeName('Mine', ['mine', 'MINE 2'])).toBe('Mine 3');
  });

  it('keeps plain and numbered names within the stored-name limit', () => {
    const long = 'x'.repeat(MAX_THEME_NAME_LENGTH);
    expect(freeThemeName(`${long} copy`, [])).toBe(long);
    expect(freeThemeName(long, [long])).toBe(`${'x'.repeat(MAX_THEME_NAME_LENGTH - 2)} 2`);
  });
});
