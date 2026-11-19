import type { languages } from 'monaco-editor';
// @ts-expect-error -- monaco-editor ships no types for its internal modules
import { toStandardTokenType } from 'monaco-editor/editor/common/languages/supports/tokenization.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getShikiTheme, loadLanguage } from '@/lib/themes/shiki-theme-loader';
import { createShikiTokensProvider, setEditorSyntax } from './tokens-provider';

let provider: languages.TokensProvider;

beforeAll(async () => {
  await getShikiTheme('github-dark');
  setEditorSyntax('github-dark');
  const highlighter = await loadLanguage('tsx');
  provider = createShikiTokensProvider(highlighter, highlighter.getLanguage('tsx'));
});

const endOf = (line: string, state = provider.getInitialState()) =>
  provider.tokenize(line, state).endState;

describe('createShikiTokensProvider', () => {
  it('ends different lines in equal states, so Monaco stops retokenizing after an edit', () => {
    const afterStatement = endOf('const a = 1;');

    expect(endOf('let b = "two";').equals(afterStatement)).toBe(true);
    expect(endOf('/* still open').equals(afterStatement)).toBe(false);
    expect(endOf('done */', endOf('/* still open')).equals(afterStatement)).toBe(true);
  });

  it('leaves a line over 20,000 characters as one plain token and keeps its start state', () => {
    const start = endOf('/* still open');

    const result = provider.tokenize('x'.repeat(20_001), start);

    expect(result.tokens).toEqual([{ startIndex: 0, scopes: '' }]);
    expect(result.endState).toBe(start);
    expect(provider.tokenize('x'.repeat(20_000), start).tokens[0].scopes).not.toBe('');
  });

  it('leaves a line that hits the time cap as one plain token and keeps its start state', async () => {
    const highlighter = await loadLanguage('tsx');
    const grammar = highlighter.getLanguage('tsx');
    const partial = { ...grammar.tokenizeLine2('x', null), stoppedEarly: true };
    // The suite's provider shares this cached grammar, so take the start state before stubbing it.
    const start = endOf('/* still open');
    const tokenizeLine2 = vi.spyOn(grammar, 'tokenizeLine2').mockReturnValueOnce(partial);

    const result = createShikiTokensProvider(highlighter, grammar).tokenize('x', start);
    tokenizeLine2.mockRestore();

    expect(result.tokens).toEqual([{ startIndex: 0, scopes: '' }]);
    expect(result.endState).toBe(start);
  });

  it("keeps the editor's code theme after a chat code block highlights with another", async () => {
    const highlighter = await loadLanguage('tsx');
    await getShikiTheme('github-light');
    const before = provider.tokenize('const a = 1;', provider.getInitialState()).tokens;

    highlighter.codeToHtml('const a = 1;', { lang: 'tsx', theme: 'github-light' });

    expect(provider.tokenize('const a = 1;', provider.getInitialState()).tokens).toEqual(before);
  });

  it('names comments and strings so Monaco knows their token type', () => {
    const line = 'const r = /a+/; const s = "hi"; // note';
    const { tokens } = provider.tokenize(line, provider.getInitialState());
    const typeAt = (text: string) => {
      const offset = line.indexOf(text);
      return toStandardTokenType(tokens.findLast((t) => t.startIndex <= offset)?.scopes ?? '');
    };

    // Monaco's StandardTokenType: Other 0, Comment 1, String 2. TextMate counts a regex as a string.
    expect(typeAt('const')).toBe(0);
    expect(typeAt('// note')).toBe(1);
    expect(typeAt('hi')).toBe(2);
    expect(typeAt('a+')).toBe(2);
  });
});
