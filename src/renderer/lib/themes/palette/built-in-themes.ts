import type { BundledTheme } from 'shiki/themes';
import type { Appearance } from './roles';
import { DEFAULT_SYNTAX, type ThemeDefinition } from './theme-schema';

export const FRINK_THEME_ID = 'frink';

/** Frink stock: globals.css owns its colours, so it carries only its syntax pairing. */
export type StockTheme = {
  id: typeof FRINK_THEME_ID;
  name: string;
  stock: true;
} & Record<Appearance, { syntax: BundledTheme }>;

/** Built-ins carry a one-line description; custom themes have none. */
export type Theme = (StockTheme | ThemeDefinition) & { description?: string };

type Described = { description: string };

export const FRINK_THEME: StockTheme & Described = {
  id: FRINK_THEME_ID,
  name: 'Frink',
  description: "Frink's own. Violet, day and night.",
  stock: true,
  light: { syntax: DEFAULT_SYNTAX.light },
  dark: { syntax: DEFAULT_SYNTAX.dark },
};

const DERIVED_THEMES: (ThemeDefinition & Described)[] = [
  {
    id: 'clay',
    name: 'Clay',
    description: 'Warm paper with a terracotta accent.',
    light: { background: '#faf9f5', accent: '#b05230', syntax: 'github-light' },
    dark: { background: '#262624', accent: '#d97857', syntax: 'github-dark' },
  },
  {
    id: 'amber',
    name: 'Amber',
    description: 'Quiet greys with a honey glow.',
    light: { background: '#fcfcfb', accent: '#9a5b13', syntax: 'min-light' },
    dark: {
      background: '#101010',
      accent: '#ffc799',
      overrides: { destructive: '#f87171' },
      syntax: 'vesper',
    },
  },
  {
    id: 'moss',
    name: 'Moss',
    description: 'Soft ink and a forest green.',
    light: {
      background: '#ffffff',
      accent: '#1e754f',
      overrides: { text: '#393a34' },
      syntax: 'vitesse-light',
    },
    dark: {
      background: '#121212',
      accent: '#4d9375',
      overrides: { text: '#dbd7ca' },
      syntax: 'vitesse-dark',
    },
  },
  {
    id: 'tide',
    name: 'Tide',
    description: 'Cool greys and sea-glass blue.',
    light: { background: '#ffffff', accent: '#2b6878', syntax: 'min-light' },
    dark: { background: '#1f1f1f', accent: '#86b3c2', syntax: 'min-dark' },
  },
  {
    id: 'sprinkles',
    name: 'Sprinkles',
    description: 'Pink and playful, still easy to read.',
    // Light accent is oklch(0.54 0.19 356).
    light: { background: '#fff7fa', accent: '#bc2b72', syntax: 'rose-pine-dawn' },
    dark: {
      background: '#1c1519',
      accent: '#ff8cc6',
      // A saturated red, so errors never read as another pink; AA on menus (4.8:1).
      overrides: { destructive: '#f87171' },
      syntax: 'rose-pine-moon',
    },
  },
];

/** The six built-in cards, in grid order. */
export const BUILT_IN_THEMES: readonly Theme[] = [FRINK_THEME, ...DERIVED_THEMES];

export function isStockTheme(theme: Theme): theme is StockTheme {
  return 'stock' in theme;
}

/** Built-ins win over custom themes; an id that no longer resolves falls back to Frink. */
export function findTheme(id: string, customThemes: readonly ThemeDefinition[]): Theme {
  return (
    BUILT_IN_THEMES.find((theme) => theme.id === id) ??
    customThemes.find((theme) => theme.id === id) ??
    FRINK_THEME
  );
}

/** A free id for a new custom theme: the slugged name, suffixed `-2`, `-3`… on collision. */
export function uniqueThemeId(name: string, customThemes: readonly ThemeDefinition[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'theme';
  const taken = new Set([...BUILT_IN_THEMES, ...customThemes].map((theme) => theme.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}
