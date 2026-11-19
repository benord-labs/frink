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
  it("paints Monarch's own token names with the code theme's colours", async () => {
    const rules = await rulesFor('github-dark');

    expect(colourOf(rules, 'number')).toBe('#79b8ff');
    expect(colourOf(rules, 'type')).toBe('#b392f0');
    expect(colourOf(rules, 'string.key.json')).toBe('#79b8ff');
    expect(colourOf(rules, 'string.value.json')).toBe('#9ecbff');
    expect(colourOf(rules, '')).toBe('#e1e4e8');
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
    expect(colourOf(rules, 'string')).toBe('#aabbcc');
    // A Monarch token whose scope the theme leaves unstyled shows the theme's text colour, as in chat.
    expect(colourOf(rules, 'number')).toBe('#aabbcc');
    expect(colourOf(rules, '')).toBe('#aabbcc');
  });
});
