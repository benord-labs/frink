// @vitest-environment happy-dom
import * as monaco from 'monaco-editor';
// @ts-expect-error -- monaco-editor ships no types for its internal modules
import { TokenizationRegistry } from 'monaco-editor/editor/common/languages.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getShikiTheme, loadLanguage } from '@/lib/themes/shiki-theme-loader';
import { shikiThemeToMonacoRules } from '../shiki-theme-to-monaco';
import { registerShikiTokenizers } from './register';
import { setEditorSyntax } from './tokens-provider';

const report = vi.fn();
// Grammars and Monaco's own language definitions load as dynamic imports, slow on a busy machine.
const slow = { timeout: 10_000 };

/** The colour the model paints at the first occurrence of `text` on line 1. */
function colourAt(model: monaco.editor.ITextModel, text: string) {
  const html = monaco.editor.colorizeModelLine(model, 1);
  const spans = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelectorAll('span[class^="mtk"]');
  const offset = model.getLineContent(1).indexOf(text);
  let end = 0;
  for (const span of spans) {
    end += span.textContent?.length ?? 0;
    if (end <= offset) continue;
    const index = Number(/mtk(\d+)/.exec(span.className)?.[1]);
    return `${TokenizationRegistry.getColorMap()[index]}`.toLowerCase();
  }
  return undefined;
}

beforeAll(async () => {
  // Features that start a language worker can't run here; only the tokenizer is under test.
  for (const defaults of [monaco.json.jsonDefaults, monaco.typescript.typescriptDefaults]) {
    defaults.setModeConfiguration(
      Object.fromEntries(Object.keys(defaults.modeConfiguration).map((key) => [key, false])),
    );
  }
  const theme = await getShikiTheme('github-dark');
  monaco.editor.defineTheme('test', {
    base: 'vs-dark',
    inherit: false,
    rules: shikiThemeToMonacoRules(theme),
    colors: {},
  });
  monaco.editor.setTheme('test');
  setEditorSyntax('github-dark');
});

describe('registerShikiTokenizers', () => {
  it('takes over a TypeScript model Monaco had already tokenized', async () => {
    const model = monaco.editor.createModel(
      'function foo() { return <div className="x" />; }',
      'typescript',
    );
    // Monaco's own tokenizer colours keywords but leaves function names in the plain foreground.
    await vi.waitFor(() => expect(colourAt(model, 'function')).toBe('#f97583'), slow);
    expect(colourAt(model, 'foo')).toBe('#e1e4e8');

    registerShikiTokenizers(monaco, { report });

    await vi.waitFor(() => expect(colourAt(model, 'foo')).toBe('#b392f0'), slow);
    // .tsx files share the typescript id, so it runs the tsx grammar: a JSX tag, not a function call.
    expect(colourAt(model, 'div')).toBe('#85e89d');
    model.dispose();
  });

  it('tokenizes a language whose Shiki grammar has another name', async () => {
    registerShikiTokenizers(monaco, { report });
    const model = monaco.editor.createModel('contract Foo { uint x; }', 'sol');

    await vi.waitFor(() => expect(colourAt(model, 'uint')).toBe('#79b8ff'), slow);
    model.dispose();
  });

  it('tokenizes JSON with Shiki rather than the JSON mode', async () => {
    registerShikiTokenizers(monaco, { report });
    const model = monaco.editor.createModel('{"name": "frink"}', 'json');

    // JSON mode colours a key as a string; chat colours it as a property name.
    await vi.waitFor(() => expect(colourAt(model, 'name')).toBe('#79b8ff'), slow);
    model.dispose();
  });

  it("hands JSON back to the JSON mode's own tokenizer when its grammar fails to load", async () => {
    const model = monaco.editor.createModel('{"name": "frink"}', 'json');
    await vi.waitFor(() => expect(colourAt(model, 'name')).toBe('#79b8ff'), slow);

    registerShikiTokenizers(monaco, {
      report,
      load: (id) => (id === 'json' ? Promise.reject(new Error('chunk failed')) : loadLanguage(id)),
    });

    // The JSON mode colours a key as a string, where Shiki colours it as a property name.
    await vi.waitFor(() => expect(colourAt(model, 'name')).toBe('#9ecbff'), slow);
    expect(monaco.json.jsonDefaults.modeConfiguration.tokens).toBe(true);
    model.dispose();
    report.mockClear();
  });

  it("falls back to Monaco's own tokenizer when a grammar fails to load", async () => {
    const error = new Error('chunk failed');
    registerShikiTokenizers(monaco, {
      report,
      load: (id) => (id === 'python' ? Promise.reject(error) : loadLanguage(id)),
    });
    const model = monaco.editor.createModel('def foo(): return "hi"', 'python');

    await vi.waitFor(() => expect(colourAt(model, 'def')).toBe('#f97583'), slow);
    expect(monaco.editor.tokenize('def foo(): pass', 'python')[0][0].type).toBe('keyword.python');
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(error, expect.anything());
    model.dispose();
  });
});
