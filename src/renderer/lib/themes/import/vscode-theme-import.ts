// culori's colour modes are registered by ../palette/color, imported below.
import { blend, type Color, formatHex, parse } from 'culori/fn';
import { type BundledTheme, bundledThemes } from 'shiki/themes';
import { z } from 'zod';
import { isDarkColor } from '../palette/color';
import { derivePalette } from '../palette/derive';
import type { Appearance, Role, RoleOverrides } from '../palette/roles';
import { DEFAULT_SYNTAX, type Half, MAX_THEME_NAME_LENGTH } from '../palette/theme-schema';
import { readableAccent, readsOn } from './readable';

/** One appearance read from a VS Code colour theme. */
export type ImportedHalf = {
  name: string;
  sourceName?: string;
  appearance: Appearance;
  half: Half;
};

/** The parts of a VS Code colour theme file Frink reads; anything unusable is dropped. */
export const VsCodeThemeFileSchema = z
  .object({
    name: z.string().optional().catch(undefined),
    displayName: z.string().optional().catch(undefined),
    type: z.string().toLowerCase().optional().catch(undefined),
    colors: z.record(z.string(), z.string().catch('')).catch({}),
    tokenColors: z.array(z.unknown()).optional().catch(undefined),
  })
  // Workbench colours are keyed by dotted ids (`editor.background`), which Frink files never use.
  .refine(
    (file) =>
      file.tokenColors !== undefined || Object.keys(file.colors).some((key) => key.includes('.')),
  );

export type VsCodeThemeFile = z.infer<typeof VsCodeThemeFileSchema>;

type WorkbenchColors = VsCodeThemeFile['colors'];

const BACKGROUND_KEYS = ['editor.background', 'editorPane.background'];
const TEXT_KEYS = ['editor.foreground', 'foreground'];
// In priority order, but the first that reads on the background wins.
const ACCENT_KEYS = [
  'button.background',
  'focusBorder',
  'textLink.foreground',
  'activityBarBadge.background',
  'progressBar.background',
  'badge.background',
];

// Surfaces the theme sets are kept; the rest are derived from the two seeds.
const SURFACE_KEYS: readonly [Role, string[]][] = [
  ['surface', ['sideBar.background', 'panel.background']],
  ['sidebar', ['sideBar.background', 'panel.background']],
  ['overlay', ['dropdown.background', 'menu.background', 'editorWidget.background']],
  ['field', ['input.background', 'editorWidget.background', 'dropdown.background']],
  ['subtleSurface', ['button.secondaryBackground']],
  [
    'highlightSurface',
    ['list.hoverBackground', 'list.activeSelectionBackground', 'editor.selectionBackground'],
  ],
  [
    'border',
    ['panel.border', 'sideBar.border', 'editorGroup.border', 'input.border', 'contrastBorder'],
  ],
  ['input', ['input.border', 'panel.border', 'sideBar.border', 'contrastBorder']],
];

// Foregrounds are kept only when they read on every surface they sit on.
const FOREGROUND_KEYS: readonly [Role, string[], Role[]][] = [
  [
    'mutedText',
    ['tab.inactiveForeground', 'descriptionForeground', 'editorLineNumber.foreground'],
    ['background', 'muted', 'highlightSurface'],
  ],
  [
    'subtleForeground',
    ['button.secondaryForeground', 'sideBar.foreground', 'foreground'],
    ['subtleSurface'],
  ],
  [
    'highlightForeground',
    ['list.activeSelectionForeground', 'list.hoverForeground', 'foreground'],
    ['highlightSurface'],
  ],
  ['accentForeground', ['button.foreground', 'activityBarBadge.foreground'], ['accent']],
  [
    'destructive',
    ['errorForeground', 'editorError.foreground', 'inputValidation.errorBorder'],
    ['background', 'overlay'],
  ],
];

/** The first of `keys` holding a colour: #rgb, #rgba, #rrggbb or #rrggbbaa. */
function firstColor(colors: WorkbenchColors, keys: readonly string[]): Color | undefined {
  for (const key of keys) {
    const color = parse(colors[key] ?? '');
    if (color) return color;
  }
  return undefined;
}

/** Roles are opaque, so a translucent VS Code colour is composited onto the surface it sits on. */
function solidColor(
  colors: WorkbenchColors,
  keys: readonly string[],
  base: string,
): string | undefined {
  const color = firstColor(colors, keys);
  return color && formatHex(blend([base, color]));
}

function appearanceOf(type: string | undefined, background: string): Appearance {
  if (type === 'light' || type === 'hc-light') return 'light';
  if (type === 'dark' || type === 'hc-black') return 'dark';
  return isDarkColor(background) ? 'dark' : 'light';
}

/** Extension names are often package slugs (`github-dark-dimmed`); read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  const words =
    /\s/.test(trimmed) || !/[-_.]/.test(trimmed)
      ? trimmed
      : trimmed
          .split(/[-_.]+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
  return words.slice(0, MAX_THEME_NAME_LENGTH).trim();
}

function themeName(file: VsCodeThemeFile, sourceName?: string): string {
  const stem = sourceName?.replace(/\.[^.]+$/, '');
  for (const candidate of [file.displayName, file.name, stem]) {
    const name = humanizeThemeName(candidate ?? '');
    if (name) return name;
  }
  return 'Imported theme';
}

function isBundledTheme(id: string): id is BundledTheme {
  return Object.hasOwn(bundledThemes, id);
}

/** A Shiki theme of the same name (Dracula, Nord, Tokyo Night…) keeps the theme's code colours. */
function syntaxFor(name: string, appearance: Appearance): BundledTheme {
  const slug = name.toLowerCase().replace(/\s+/g, '-');
  return isBundledTheme(slug) ? slug : DEFAULT_SYNTAX[appearance];
}

/**
 * Seeds from the theme's editor background and accent, plus the workbench colours it sets that
 * still read well in Frink. Undefined when the theme has no background to build on.
 */
export function fromVsCodeTheme(
  file: VsCodeThemeFile,
  sourceName?: string,
): ImportedHalf | undefined {
  const { colors } = file;
  // Vibrancy themes clear the editor background; it has nothing to seed from.
  const canvas = BACKGROUND_KEYS.map((key) => parse(colors[key] ?? '')).find(
    (color) => color && color.alpha !== 0,
  );
  if (!canvas) return undefined;
  const background = formatHex(canvas);
  const overrides: RoleOverrides = {};
  for (const [role, keys] of SURFACE_KEYS) {
    const color = solidColor(colors, keys, background);
    if (color) overrides[role] = color;
  }
  const text = solidColor(colors, TEXT_KEYS, background);
  if (text && readsOn(text, [background])) overrides.text = text;
  const accents = ACCENT_KEYS.flatMap((key) => solidColor(colors, [key], background) ?? []);
  const accent =
    accents.find((color) => readsOn(color, [background])) ??
    readableAccent(accents[0] ?? background, background);

  const derived = derivePalette({ background, accent, overrides });
  for (const [role, keys, surfaceRoles] of FOREGROUND_KEYS) {
    const surfaces = surfaceRoles.map((surface) => derived[surface]);
    const specified = solidColor(colors, keys, surfaces[0]);
    if (specified && readsOn(specified, surfaces)) overrides[role] = specified;
    // The derived pick can fail on a surface the theme replaced; then black or white.
    else if (!readsOn(derived[role], surfaces))
      overrides[role] = isDarkColor(surfaces[0]) ? '#ffffff' : '#000000';
  }

  const name = themeName(file, sourceName);
  const appearance = appearanceOf(file.type, background);
  const half = { background, accent, overrides, syntax: syntaxFor(name, appearance) };
  return { name, sourceName, appearance, half };
}
