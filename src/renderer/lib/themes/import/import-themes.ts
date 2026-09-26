import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import { BUILT_IN_THEMES, uniqueThemeId } from '../palette/built-in-themes';
import type { Appearance } from '../palette/roles';
import {
  freeThemeName,
  type Half,
  type ThemeDefinition,
  ThemeDefinitionSchema,
  ThemeFileSchema,
} from '../palette/theme-schema';
import { type ImportedTheme, pairThemes, resolveNameCollisions } from './pair-themes';
import { readableAccent } from './readable';
import { fromVsCodeTheme, VsCodeThemeFileSchema } from './vscode-theme-import';

/** A theme file is a few KB, so anything past this is never read into memory. */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

/** A chosen or dropped file (a DOM `File` fits), or pasted text, which has no name. */
export type ThemeSource = { name?: string; size: number; text: () => Promise<string> };

export type ConflictChoice = 'keep-both' | 'replace';

/** A Frink theme file, or a VS Code colour theme written as JSON with comments. */
function readTheme(text: string, sourceName?: string): ImportedTheme | undefined {
  // A hostile file can nest deep enough to overflow the parser's stack.
  try {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) return undefined;
    const file = ThemeFileSchema.safeParse(value);
    if (file.success) return { ...file.data, sourceName };
    const vsCode = VsCodeThemeFileSchema.safeParse(value);
    return vsCode.success ? fromVsCodeTheme(vsCode.data, sourceName) : undefined;
  } catch {
    return undefined;
  }
}

/** A VS Code theme's missing half is Frink's own, in the imported accent. */
function completeTheme(theme: ImportedTheme, stockHalf: (appearance: Appearance) => Half) {
  if (!('half' in theme)) return theme;
  const missing: Appearance = theme.appearance === 'light' ? 'dark' : 'light';
  const stock = stockHalf(missing);
  // Dropped so the text on the accent is re-derived for the new accent.
  const { accentForeground, ...overrides } = stock.overrides ?? {};
  const other = {
    ...stock,
    accent: readableAccent(theme.half.accent, stock.background),
    overrides,
  };
  return {
    name: theme.name,
    light: missing === 'light' ? other : theme.half,
    dark: missing === 'dark' ? other : theme.half,
  };
}

/** Each theme keeps its file's id when free in the batch; a clash with a saved theme is the user's call. */
function withIds(
  themes: readonly { name: string; id?: string; light: Half; dark: Half }[],
): ThemeDefinition[] {
  const result: ThemeDefinition[] = [];
  for (const theme of themes) {
    const clash = [...BUILT_IN_THEMES, ...result].some((each) => each.id === theme.id);
    const id = theme.id && !clash ? theme.id : uniqueThemeId(theme.name, result);
    result.push(ThemeDefinitionSchema.parse({ ...theme, id }));
  }
  return result;
}

/**
 * Reads every source into complete themes, pairing light and dark VS Code files. Stock Frink fills
 * a missing half, so `stockHalf` (which reads the DOM) runs here: call from handlers only.
 */
export async function importThemes(
  sources: readonly ThemeSource[],
  stockHalf: (appearance: Appearance) => Half,
) {
  const read: ImportedTheme[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    const subject = source.name ? `“${source.name}”` : 'The pasted text';
    if (source.size > MAX_THEME_FILE_BYTES) {
      errors.push(`${subject} is too big to be a theme. Theme files are only a few KB.`);
      continue;
    }
    const theme = readTheme(await source.text().catch(() => ''), source.name);
    if (theme) read.push(theme);
    else errors.push(`${subject} isn't a theme we can read.`);
  }
  const complete = pairThemes(resolveNameCollisions(read)).map((theme) =>
    completeTheme(theme, stockHalf),
  );
  return { themes: withIds(complete), errors };
}

/** Kept alongside the saved theme with the same id, under a free name and id. */
export function keptCopy(
  theme: ThemeDefinition,
  themes: readonly ThemeDefinition[],
): ThemeDefinition {
  const name = freeThemeName(
    theme.name,
    themes.map((each) => each.name),
  );
  return { ...theme, name, id: uniqueThemeId(name, themes) };
}

/** `incoming` saved into `existing`; one whose id is taken replaces it in place or is kept as a copy. */
export function mergeImportedThemes(
  existing: readonly ThemeDefinition[],
  incoming: readonly ThemeDefinition[],
  choice: ConflictChoice,
) {
  const themes = [...existing];
  const imported: ThemeDefinition[] = [];
  for (const theme of incoming) {
    const index = themes.findIndex((each) => each.id === theme.id);
    if (index !== -1 && choice === 'replace') {
      themes[index] = theme;
      imported.push(theme);
      continue;
    }
    const saved = index === -1 ? theme : keptCopy(theme, themes);
    themes.push(saved);
    imported.push(saved);
  }
  return { themes, imported };
}
