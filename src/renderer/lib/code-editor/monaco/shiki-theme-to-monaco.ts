import type { ThemeRegistrationResolved } from 'shiki';

export type MonacoTokenRule = { token: string; foreground?: string; fontStyle?: string };

// TextMate's FontStyle bits, in the order Monaco's fontStyle string names them.
const FONT_STYLES = ['italic', 'bold', 'underline', 'strikethrough'] as const;

// normalizeColor and the scope-to-rule loop are adapted from Shiki's @shikijs/monaco (MIT).
export function normalizeColor(color: string | undefined, theme: ThemeRegistrationResolved) {
  const replaced = color && (theme.colorReplacements?.[color.toLowerCase()] ?? color);
  // Shiki swaps colours that are not hex (names, CSS vars) for placeholders; Monaco can't paint them.
  if (!replaced?.startsWith('#')) return undefined;
  const hex = replaced.slice(1).toLowerCase();
  // Monaco only reads 6- and 8-digit hex.
  return `#${hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex}`;
}

/**
 * The Monaco token the Shiki tokenizer emits for a colour (from normalizeColor) and TextMate
 * font-style bits. The theme rules below paint it, so editor colours are chat's own.
 */
export function colourToken(colour: string | undefined, fontStyle = 0) {
  const base = colour ? `shiki-${colour.slice(1)}` : 'shiki';
  return fontStyle ? `${base}.f${fontStyle}` : base;
}

function fontStyleBits(fontStyle: string) {
  return FONT_STYLES.reduce(
    (bits, style, i) => (fontStyle.includes(style) ? bits | (1 << i) : bits),
    0,
  );
}

function fontStyleName(bits: number) {
  return FONT_STYLES.filter((_, i) => bits & (1 << i)).join(' ');
}

function selectorsOf(scope: string | string[] | undefined): string[] {
  const parts = (Array.isArray(scope) ? scope : (scope?.split(',') ?? [])).map((s) => s.trim());
  // Monaco matches one dotted token, so descendant selectors ("a b") can't be expressed.
  return parts.filter((s) => s && !s.includes(' '));
}

/** A rule per theme colour, and per colour and font style the theme uses, for the Shiki tokenizer. */
function colourTokenRules(theme: ThemeRegistrationResolved): MonacoTokenRule[] {
  const colours = new Set<string>();
  const styles = new Set<number>();
  for (const { settings = {} } of [...theme.settings, { settings: { foreground: theme.fg } }]) {
    const colour = normalizeColor(settings.foreground, theme);
    if (colour) colours.add(colour);
    const bits = fontStyleBits(settings.fontStyle ?? '');
    if (bits) styles.add(bits);
  }
  return [...colours].flatMap((foreground) => [
    { token: colourToken(foreground), foreground },
    ...[...styles].map((bits) => ({
      token: colourToken(foreground, bits),
      foreground,
      fontStyle: fontStyleName(bits),
    })),
  ]);
}

/**
 * Monaco token rules for a Shiki theme: its TextMate scopes, which colour the languages Monaco
 * still tokenizes itself, and the colour tokens the Shiki tokenizer emits.
 */
export function shikiThemeToMonacoRules(theme: ThemeRegistrationResolved): MonacoTokenRule[] {
  const rules: MonacoTokenRule[] = [];
  // Some bundled themes (vesper) carry an entry with a scope and no settings.
  for (const { scope, settings = {} } of theme.settings) {
    const foreground = normalizeColor(settings.foreground, theme);
    // An empty fontStyle is a deliberate reset (a nested scope that is not italic), so keep it.
    const { fontStyle } = settings;
    if (!foreground && fontStyle === undefined) continue;
    for (const token of selectorsOf(scope)) {
      rules.push({
        token,
        ...(foreground && { foreground }),
        ...(fontStyle !== undefined && { fontStyle }),
      });
    }
  }

  const fg = normalizeColor(theme.fg, theme);
  // Plain text takes the theme's foreground, as in chat code blocks, not the editor chrome's text.
  return [...rules, ...colourTokenRules(theme), ...(fg ? [{ token: '', foreground: fg }] : [])];
}
