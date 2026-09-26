import { describe, expect, it, vi } from 'vitest';
import { contrastRatio } from '../palette/color';
import type { Appearance } from '../palette/roles';
import { DEFAULT_SYNTAX, serializeThemeFile, type ThemeDefinition } from '../palette/theme-schema';
import {
  importThemes,
  keptCopy,
  MAX_THEME_FILE_BYTES,
  mergeImportedThemes,
  type ThemeSource,
} from './import-themes';

// Stand-in for the globals.css snapshot.
const stockHalf = (appearance: Appearance) => ({
  background: appearance === 'light' ? '#ffffff' : '#0a0a0a',
  accent: '#0034ff',
  overrides: { text: appearance === 'light' ? '#0a0a0a' : '#fafafa', accentForeground: '#ffffff' },
  syntax: DEFAULT_SYNTAX[appearance],
});

const source = (text: string, name?: string): ThemeSource => ({
  name,
  size: text.length,
  text: () => Promise.resolve(text),
});

const vsCode = (name: string, type: Appearance, background: string, link: string) =>
  JSON.stringify({
    name,
    type,
    colors: { 'editor.background': background, 'textLink.foreground': link },
  });

const MINE: ThemeDefinition = {
  id: 'mine',
  name: 'Mine',
  light: { background: '#fff7fa', accent: '#bc2b72', syntax: 'github-light' },
  dark: {
    background: '#1c1519',
    accent: '#ff8cc6',
    overrides: { destructive: '#ef4444' },
    syntax: 'rose-pine-moon',
  },
};

describe('importThemes', () => {
  it('reads a VS Code theme written as JSON with comments and trailing commas', async () => {
    const jsonc = `{
      // Night Owl
      "name": "Night Owl",
      "type": "dark",
      "colors": {
        "editor.background": "#011627", /* canvas */
        "textLink.foreground": "#82aaff",
      },
    }`;
    const { themes, errors } = await importThemes([source(jsonc, 'night-owl.json')], stockHalf);
    expect(errors).toEqual([]);
    expect(themes).toMatchObject([
      { id: 'night-owl', name: 'Night Owl', dark: { background: '#011627', accent: '#82aaff' } },
    ]);
  });

  it("fills a single appearance's other half from Frink, in a readable imported accent", async () => {
    const { themes } = await importThemes(
      [source(vsCode('Peach', 'dark', '#101010', '#ffc799'))],
      stockHalf,
    );
    const { light } = themes[0];
    expect(light).toMatchObject({ background: '#ffffff', overrides: { text: '#0a0a0a' } });
    expect(light.overrides).not.toHaveProperty('accentForeground');
    expect(light.accent).not.toBe('#0034ff');
    expect(contrastRatio(light.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('pairs light and dark files into one theme', async () => {
    const { themes } = await importThemes(
      [
        source(vsCode('GitHub Light', 'light', '#ffffff', '#0969da'), 'github-light.json'),
        source(vsCode('GitHub Dark', 'dark', '#0d1117', '#4493f8'), 'github-dark.json'),
      ],
      stockHalf,
    );
    expect(themes).toMatchObject([
      {
        id: 'github',
        name: 'GitHub',
        light: { background: '#ffffff', accent: '#0969da', syntax: 'github-light' },
        dark: { background: '#0d1117', accent: '#4493f8', syntax: 'github-dark' },
      },
    ]);
  });

  it('round-trips a Frink theme file', async () => {
    const { themes } = await importThemes([source(serializeThemeFile(MINE))], stockHalf);
    expect(themes).toEqual([MINE]);
  });

  it('never takes a built-in id, and keeps ids unique within a batch', async () => {
    const file = serializeThemeFile({ ...MINE, id: 'clay', name: 'Clay' });
    const { themes } = await importThemes([source(file), source(file)], stockHalf);
    expect(themes.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'clay-2', name: 'Clay' },
      { id: 'clay-2-2', name: 'Clay 2' },
    ]);
  });

  it('refuses oversized sources without reading them', async () => {
    const text = vi.fn(() => Promise.resolve(''));
    const { themes, errors } = await importThemes(
      [{ name: 'huge.json', size: MAX_THEME_FILE_BYTES + 1, text }],
      stockHalf,
    );
    expect(text).not.toHaveBeenCalled();
    expect(themes).toEqual([]);
    expect(errors).toEqual([
      '“huge.json” is too big to be a theme. Theme files are only a few KB.',
    ]);
  });

  it('explains what it could not read and imports the rest', async () => {
    const { themes, errors } = await importThemes(
      [
        source('not json', 'notes.json'),
        source(JSON.stringify({ colors: { 'editor.foreground': '#fff' } }), 'no-background.json'),
        source('{"name": "Half a theme"}'),
        source('['.repeat(200_000), 'nested.json'),
        source(serializeThemeFile(MINE), 'mine.json'),
      ],
      stockHalf,
    );
    expect(themes.map((theme) => theme.id)).toEqual(['mine']);
    expect(errors).toEqual([
      "“notes.json” isn't a theme we can read.",
      "“no-background.json” isn't a theme we can read.",
      "The pasted text isn't a theme we can read.",
      "“nested.json” isn't a theme we can read.",
    ]);
  });
});

describe('mergeImportedThemes', () => {
  const incoming = { ...MINE, light: { ...MINE.light, accent: '#1e754f' } };

  it('keeps both under a free name and id', () => {
    const { themes, imported } = mergeImportedThemes([MINE], [incoming], 'keep-both');
    const copy = { ...incoming, id: 'mine-2', name: 'Mine 2' };
    expect(themes).toEqual([MINE, copy]);
    expect(imported).toEqual([copy]);
  });

  it('replaces the saved theme in place', () => {
    const other = { ...MINE, id: 'other', name: 'Other' };
    const { themes, imported } = mergeImportedThemes([MINE, other], [incoming], 'replace');
    expect(themes).toEqual([incoming, other]);
    expect(imported).toEqual([incoming]);
  });
});

describe('keptCopy', () => {
  it('takes the next free name and id among every saved theme', () => {
    const second = { ...MINE, id: 'mine-2', name: 'Mine 2' };
    expect(keptCopy(MINE, [MINE, second])).toEqual({ ...MINE, id: 'mine-3', name: 'Mine 3' });
  });
});
