import { type BundledTheme, bundledThemes, normalizeTheme } from 'shiki';
import { describe, expect, it } from 'vitest';
import { shikiThemeToMonacoRules } from './shiki-theme-to-monaco';

async function rulesFor(id: BundledTheme) {
  return shikiThemeToMonacoRules(normalizeTheme((await bundledThemes[id]()).default));
}

/** The colour Monaco resolves for a token: its last rule wins. */
function colourOf(rules: Awaited<ReturnType<typeof rulesFor>>, token: string) {
  return rules.findLast((rule) => rule.token === token)?.foreground;
}

describe('shikiThemeToMonacoRules', () => {
  it('paints each colour token, in each font style the theme uses, with its own colour', async () => {
    const rules = await rulesFor('one-dark-pro');

    expect(colourOf(rules, 'shiki-61afef')).toBe('#61afef');
    expect(rules).toContainEqual({
      token: 'shiki-7f848e.f1',
      foreground: '#7f848e',
      fontStyle: 'italic',
    });
    expect(colourOf(rules, '')).toBe('#abb2bf');
  });

  it('gives a light theme its own rules', async () => {
    const rules = await rulesFor('github-light');

    expect(colourOf(rules, 'comment')).toBe('#6a737d');
    expect(colourOf(rules, 'keyword')).toBe('#d73a49');
    expect(colourOf(rules, '')).toBe('#24292e');
  });

  it('splits comma-joined scopes, keeps font styles and drops descendant selectors', async () => {
    const rules = await rulesFor('one-dark-pro');

    expect(rules).toContainEqual(
      expect.objectContaining({ token: 'punctuation.definition.list.begin.unison' }),
    );
    expect(rules).toContainEqual({ token: 'comment', foreground: '#7f848e', fontStyle: 'italic' });
    expect(rules.some((rule) => rule.token.includes(' ') || rule.token.includes(','))).toBe(false);
  });

  it('expands short hex and applies the theme colour replacements', () => {
    const rules = shikiThemeToMonacoRules(
      normalizeTheme({
        type: 'dark',
        fg: '#abc',
        bg: '#000',
        colorReplacements: { '#111111': '#222222' },
        settings: [
          { scope: 'keyword', settings: { foreground: '#111111' } },
          { scope: 'string', settings: { foreground: 'red' } },
        ],
      }),
    );

    expect(colourOf(rules, 'keyword')).toBe('#222222');
    expect(colourOf(rules, 'shiki-222222')).toBe('#222222');
    // Monaco can't paint a named colour, so that scope falls back to the theme's text colour.
    expect(colourOf(rules, 'string')).toBeUndefined();
    expect(colourOf(rules, '')).toBe('#aabbcc');
  });
});
