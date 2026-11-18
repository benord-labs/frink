import type { ThemeRegistrationResolved } from 'shiki';

export type MonacoTokenRule = { token: string; foreground?: string; fontStyle?: string };

/**
 * Monarch token names, each coloured as chat colours its first TextMate scope (the theme's text
 * colour when no rule styles it).
 */
const MONARCH_ALIASES: Array<[token: string, scopes: string[]]> = [
  ['comment', ['comment.line.double-slash']],
  ['comment.doc', ['comment.block.documentation']],
  ['string', ['string.quoted.double']],
  ['keyword', ['keyword.control']],
  ['number', ['constant.numeric']],
  ['type', ['entity.name.type', 'support.type', 'storage.type']],
  ['delimiter', ['punctuation']],
  ['string.key.json', ['support.type.property-name.json']],
  ['string.value.json', ['string.quoted.double.json']],
  ['keyword.json', ['constant.language.json']],
  ['regexp', ['string.regexp']],
  ['tag', ['entity.name.tag']],
  ['attribute.name', ['entity.other.attribute-name']],
  ['attribute.value', ['string.quoted']],
  ['variable.predefined', ['variable.language', 'support.variable']],
];

// normalizeColor and the scope-to-rule loop are adapted from Shiki's @shikijs/monaco (MIT).
function normalizeColor(color: string | undefined, theme: ThemeRegistrationResolved) {
  const replaced = color && (theme.colorReplacements?.[color.toLowerCase()] ?? color);
  // Shiki swaps colours that are not hex (names, CSS vars) for placeholders; Monaco can't paint them.
  if (!replaced?.startsWith('#')) return undefined;
  const hex = replaced.slice(1).toLowerCase();
  // Monaco only reads 6- and 8-digit hex.
  return `#${hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex}`;
}

function selectorsOf(scope: string | string[] | undefined): string[] {
  const parts = (Array.isArray(scope) ? scope : (scope?.split(',') ?? [])).map((s) => s.trim());
  // Monaco matches one dotted token, so descendant selectors ("a b") can't be expressed.
  return parts.filter((s) => s && !s.includes(' '));
}

/** The value of `property` from the longest selector prefixing `scope`; TextMate resolves each property alone. */
function resolveScope(
  rules: MonacoTokenRule[],
  scope: string,
  property: 'foreground' | 'fontStyle',
): string | undefined {
  let best: MonacoTokenRule | undefined;
  for (const rule of rules) {
    const matches = scope === rule.token || scope.startsWith(`${rule.token}.`);
    if (matches && rule[property] !== undefined && rule.token.length >= (best?.token.length ?? 0)) {
      best = rule;
    }
  }
  return best?.[property];
}

/** Monaco token rules that paint Monarch tokens with a Shiki theme's colours. */
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
  const aliases = MONARCH_ALIASES.flatMap(([token, scopes]) => {
    const scope = scopes.find((s) => resolveScope(rules, s, 'foreground')) ?? scopes[0];
    const foreground = resolveScope(rules, scope, 'foreground') ?? fg;
    const fontStyle = resolveScope(rules, scope, 'fontStyle');
    return foreground ? [{ token, foreground, ...(fontStyle !== undefined && { fontStyle }) }] : [];
  });

  // Plain text takes the theme's foreground, as in chat code blocks, not the editor chrome's text.
  return [...rules, ...aliases, ...(fg ? [{ token: '', foreground: fg }] : [])];
}
