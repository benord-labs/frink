import { describe, expect, it } from 'vitest';
import type { Appearance } from '../palette/roles';
import { DEFAULT_SYNTAX } from '../palette/theme-schema';
import { pairThemes, resolveNameCollisions } from './pair-themes';
import type { ImportedHalf } from './vscode-theme-import';

function half(name: string, appearance: Appearance, sourceName?: string): ImportedHalf {
  const background = appearance === 'light' ? '#ffffff' : '#0d1117';
  return {
    name,
    sourceName,
    appearance,
    half: { background, accent: '#0969da', syntax: DEFAULT_SYNTAX[appearance] },
  };
}

describe('pairThemes', () => {
  it('merges a light and a dark theme that differ only by the appearance word', () => {
    const [light, dark, dimmed] = [
      half('GitHub Light', 'light'),
      half('GitHub Dark', 'dark'),
      half('GitHub Dark Dimmed', 'dark'),
    ];
    expect(pairThemes([light, dark, dimmed])).toEqual([
      { name: 'GitHub', light: light.half, dark: dark.half },
      dimmed,
    ]);
  });

  it('leaves ambiguous groups and names without an appearance word alone', () => {
    const themes = [
      half('Monokai Light', 'light'),
      half('Monokai Dark', 'dark'),
      half('monokai dark', 'dark'),
      half('Dracula', 'dark'),
    ];
    expect(pairThemes(themes)).toEqual(themes);
  });
});

describe('resolveNameCollisions', () => {
  it('renames a repeated name from its file, then numbers what still clashes', () => {
    const themes = [
      half('Dracula', 'dark', 'dracula.json'),
      half('Dracula', 'dark', 'dracula-soft.json'),
      half('Dracula', 'dark'),
    ];
    expect(resolveNameCollisions(themes).map((theme) => theme.name)).toEqual([
      'Dracula',
      'Dracula Soft',
      'Dracula 2',
    ]);
  });
});
