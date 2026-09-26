import { type BundledTheme, bundledThemes } from 'shiki/themes';
import { z } from 'zod';
import { toHex } from './color';
import { type Appearance, ROLES, type RoleOverrides } from './roles';

const THEME_FILE_VERSION = 1;

/** A longer stored name fails to decode and makes the whole custom-theme library unavailable. */
export const MAX_THEME_NAME_LENGTH = 48;

/** Syntax pairing for Frink stock, and the fallback for an unknown Shiki name. */
export const DEFAULT_SYNTAX = {
  light: 'github-light',
  dark: 'github-dark',
} as const satisfies Record<Appearance, BundledTheme>;

// SAFETY: bundledThemes is keyed by exactly the BundledTheme union.
const SYNTAX_NAMES = Object.keys(bundledThemes) as [BundledTheme, ...BundledTheme[]];

/** Any CSS colour culori parses, canonicalised to `#rrggbb`. */
const ColorSchema = z
  .string()
  .transform((value) => toHex(value))
  .pipe(z.string());

/** Unknown roles and unparseable colours are dropped so themes from other builds keep the rest. */
function lenientOverrides(value: Record<string, string>): RoleOverrides {
  const overrides: RoleOverrides = {};
  for (const role of ROLES) {
    const hex = toHex(value[role] ?? '');
    if (hex) overrides[role] = hex;
  }
  return overrides;
}

function halfSchema(appearance: Appearance) {
  return z.object({
    background: ColorSchema,
    accent: ColorSchema,
    overrides: z.record(z.string(), z.string().catch('')).transform(lenientOverrides).optional(),
    syntax: z.enum(SYNTAX_NAMES).catch(DEFAULT_SYNTAX[appearance]),
  });
}

const ThemeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

export const ThemeDefinitionSchema = z.object({
  id: ThemeIdSchema,
  name: z.string().trim().min(1).max(MAX_THEME_NAME_LENGTH),
  light: halfSchema('light'),
  dark: halfSchema('dark'),
});

/** A shared theme file; `id` is optional so a hand-written file imports by name. */
export const ThemeFileSchema = ThemeDefinitionSchema.extend({
  version: z.literal(THEME_FILE_VERSION),
  id: ThemeIdSchema.optional(),
});

export type ThemeDefinition = z.infer<typeof ThemeDefinitionSchema>;
/** One appearance of a theme: two seeds, optional per-role overrides, and a Shiki theme. */
export type Half = ThemeDefinition['light'];
type ThemeFile = z.infer<typeof ThemeFileSchema>;

export type CustomThemeLibrary =
  | { status: 'ready'; themes: ThemeDefinition[] }
  | { status: 'unavailable' };

/** `name` cut to the stored limit, else `name 2`, `name 3`… so it matches none of `taken`. */
export function freeThemeName(name: string, taken: Iterable<string>): string {
  const lowered = new Set(Array.from(taken, (each) => each.toLowerCase()));
  let candidate = name.slice(0, MAX_THEME_NAME_LENGTH).trim();
  for (let n = 2; lowered.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` ${n}`;
    candidate = `${name.slice(0, MAX_THEME_NAME_LENGTH - suffix.length).trim()}${suffix}`;
  }
  return candidate;
}

export function serializeThemeFile({ id, name, light, dark }: ThemeDefinition): string {
  const file: ThemeFile = { version: THEME_FILE_VERSION, id, name, light, dark };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Decodes the stored custom-theme array. Never throws: anything that does not decode whole is
 * `unavailable`, so callers refuse writes instead of overwriting themes they could not read.
 */
export function parseStoredThemes(raw: string | null): CustomThemeLibrary {
  if (raw === null) return { status: 'ready', themes: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'unavailable' };
  }
  const parsed = z.array(ThemeDefinitionSchema).safeParse(json);
  return parsed.success ? { status: 'ready', themes: parsed.data } : { status: 'unavailable' };
}
