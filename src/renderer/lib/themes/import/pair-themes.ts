import { freeThemeName, type Half } from '../palette/theme-schema';
import { humanizeThemeName, type ImportedHalf } from './vscode-theme-import';

/** A theme read for import: one VS Code appearance, or a whole theme with both halves. */
export type ImportedTheme =
  | ImportedHalf
  | { name: string; id?: string; sourceName?: string; light: Half; dark: Half };

/**
 * Extensions reuse one name across files (dracula.json and dracula-soft.json both say "Dracula"),
 * so a repeated name takes its file's name, then a number.
 */
export function resolveNameCollisions(themes: readonly ImportedTheme[]): ImportedTheme[] {
  const counts = new Map<string, number>();
  for (const { name } of themes) {
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  }
  const taken = new Set<string>();
  return themes.map((theme) => {
    const repeated = (counts.get(theme.name.toLowerCase()) ?? 0) > 1;
    const fromFile =
      repeated && theme.sourceName
        ? humanizeThemeName(theme.sourceName.replace(/\.[^.]+$/, ''))
        : '';
    const preferred =
      fromFile && fromFile.toLowerCase() !== theme.name.toLowerCase() ? fromFile : theme.name;
    const name = freeThemeName(preferred, taken);
    taken.add(name);
    return name === theme.name ? theme : { ...theme, name };
  });
}

function withoutAppearance(name: string): string {
  return name
    .replace(/\b(?:light|dark)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only a single appearance named with "Light" or "Dark" can pair. */
function pairKey(theme: ImportedTheme): string {
  const key = withoutAppearance(theme.name);
  return 'half' in theme && key !== theme.name ? key.toLowerCase() : '';
}

/**
 * A light and a dark VS Code theme whose names differ only by "Light"/"Dark" become one theme.
 * Anything ambiguous (two darks for one light) stays as it was imported.
 */
export function pairThemes(themes: readonly ImportedTheme[]): ImportedTheme[] {
  const groups = new Map<string, ImportedHalf[]>();
  for (const theme of themes) {
    const key = pairKey(theme);
    if (key && 'half' in theme) groups.set(key, [...(groups.get(key) ?? []), theme]);
  }
  const merged = new Set<ImportedTheme>();
  const result: ImportedTheme[] = [];
  for (const theme of themes) {
    if (merged.has(theme)) continue;
    const group = groups.get(pairKey(theme)) ?? [];
    const light = group.find((each) => each.appearance === 'light');
    const dark = group.find((each) => each.appearance === 'dark');
    if (group.length !== 2 || !light || !dark) {
      result.push(theme);
      continue;
    }
    result.push({ name: withoutAppearance(theme.name), light: light.half, dark: dark.half });
    merged.add(light).add(dark);
  }
  return result;
}
