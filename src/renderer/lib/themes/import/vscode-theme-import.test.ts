import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { contrastRatio } from '../palette/color';
import { AA_FLOOR } from '../palette/derive';
import { fromVsCodeTheme, humanizeThemeName, VsCodeThemeFileSchema } from './vscode-theme-import';

const read = (file: z.input<typeof VsCodeThemeFileSchema>, sourceName?: string) =>
  fromVsCodeTheme(VsCodeThemeFileSchema.parse(file), sourceName);

const DRACULA_SOFT = {
  name: 'dracula-soft',
  type: 'dark',
  colors: {
    'editor.background': '#282A36',
    'editor.foreground': '#f8f8f2',
    'sideBar.background': '#21222c',
    'list.hoverBackground': '#44475a75',
    'input.border': '#333',
    // Neither reads on the background, so the link colour becomes the accent.
    'button.background': '#44475a',
    focusBorder: '#6272a4',
    'textLink.foreground': '#8be9fd',
    'button.foreground': '#f8f8f2',
    'tab.inactiveForeground': '#6272a4',
  },
  tokenColors: [],
};

describe('VsCodeThemeFileSchema', () => {
  it.each([
    ['dotted workbench colours', { colors: { 'editor.background': '#000' } }, true],
    ['token colours only', { tokenColors: [] }, true],
    ['a Frink theme file', { version: 1, name: 'Mine', light: {}, dark: {} }, false],
    ['an unrelated object', { colors: { background: '#000' } }, false],
    ['a non-object', [], false],
  ])('recognises %s', (_label, value, expected) => {
    expect(VsCodeThemeFileSchema.safeParse(value).success).toBe(expected);
  });

  it('keeps a file whose colour values are not all strings', () => {
    const file = { colors: { 'editor.background': 42, 'editor.foreground': '#fff' } };
    expect(VsCodeThemeFileSchema.parse(file).colors).toEqual({
      'editor.background': '',
      'editor.foreground': '#fff',
    });
  });
});

describe('parseVsCodeTheme', () => {
  it('maps a dark theme onto the dark half: seeds, surfaces and readable text', () => {
    const imported = read(DRACULA_SOFT);
    expect(imported).toMatchObject({
      name: 'Dracula Soft',
      appearance: 'dark',
      half: {
        background: '#282a36',
        accent: '#8be9fd',
        syntax: 'dracula-soft',
        overrides: {
          surface: '#21222c',
          sidebar: '#21222c',
          // #44475a at 46% alpha, composited onto the background.
          highlightSurface: '#353747',
          border: '#333333',
          input: '#333333',
          text: '#f8f8f2',
        },
      },
    });
  });

  it('drops foregrounds that would not read, leaving them to be derived', () => {
    const overrides = read(DRACULA_SOFT)?.half.overrides;
    // Muted text at 2.6:1 and white on the cyan accent at 1.3:1.
    expect(overrides).not.toHaveProperty('mutedText');
    expect(overrides).not.toHaveProperty('accentForeground');
  });

  it('falls back to black or white when the derived pick fails on a replaced surface', () => {
    const imported = read({
      type: 'dark',
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#3a3a3a',
        'list.hoverBackground': '#ffffff',
        'list.activeSelectionForeground': '#eeeeee',
        'textLink.foreground': '#3794ff',
      },
    });
    expect(imported?.half.overrides?.text).toBeUndefined();
    expect(imported?.half.overrides?.highlightForeground).toBe('#000000');
  });

  it('makes an unreadable accent readable when no candidate reads on the background', () => {
    const imported = read({
      colors: { 'editor.background': '#ffffff', 'button.background': '#ffe08a' },
    });
    const accent = imported?.half.accent ?? '';
    expect(accent).not.toBe('#ffe08a');
    expect(contrastRatio(accent, '#ffffff')).toBeGreaterThanOrEqual(AA_FLOOR);
  });

  it('reads #RGBA and falls back to the background luminance without a type', () => {
    const imported = read(
      { colors: { 'editor.background': '#fafafa', 'dropdown.background': '#0008' } },
      'paper.json',
    );
    expect(imported).toMatchObject({
      name: 'paper',
      appearance: 'light',
      // Black at 53% alpha over #fafafa.
      half: { syntax: 'github-light', overrides: { overlay: '#757575' } },
    });
  });

  it('follows the declared type over the background, and skips values that are not colours', () => {
    const imported = read({
      type: 'HC-Black',
      colors: { 'editor.background': 'transparent-ish', 'editorPane.background': '#eee' },
    });
    expect(imported).toMatchObject({ appearance: 'dark', half: { background: '#eeeeee' } });
  });

  it.each(['transparent', '#ffffff00', '#0000'])(
    'skips a fully transparent editor background (%s) for the next background key',
    (value) => {
      const imported = read({
        type: 'light',
        colors: { 'editor.background': value, 'editorPane.background': '#fafafa' },
      });
      expect(imported?.half.background).toBe('#fafafa');
    },
  );

  it('cannot build a theme when the only editor background is fully transparent', () => {
    expect(read({ type: 'light', colors: { 'editor.background': '#00000000' } })).toBeUndefined();
  });

  it('cannot build a theme without an editor background', () => {
    expect(read({ colors: { 'editor.foreground': '#fff' } })).toBeUndefined();
  });
});

describe('humanizeThemeName', () => {
  it.each([
    ['github-dark-dimmed', 'Github Dark Dimmed'],
    ['One Dark Pro', 'One Dark Pro'],
    ['nord', 'nord'],
    ['---', ''],
    ['x'.repeat(60), 'x'.repeat(48)],
  ])('reads %s as %s', (raw, expected) => {
    expect(humanizeThemeName(raw)).toBe(expected);
  });
});
