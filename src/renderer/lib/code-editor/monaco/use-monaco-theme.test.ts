// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
// @ts-expect-error -- monaco-editor ships no types for its internal modules
import { TokenTheme } from 'monaco-editor/editor/common/languages/supports/tokenization.js';
// @ts-expect-error -- monaco-editor ships no types for its internal modules
import { vs, vs_dark } from 'monaco-editor/editor/standalone/common/themes.js';
import { createElement, type ReactNode } from 'react';
import {
  type BundledTheme,
  bundledThemes,
  codeToTokens,
  normalizeTheme,
  type ThemeRegistrationResolved,
} from 'shiki';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivePalette } from '@/lib/themes/palette/apply';
import { derivePalette } from '@/lib/themes/palette/derive';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';
import { type MonacoTokenRule, shikiThemeToMonacoRules } from './shiki-theme-to-monaco';
import { monacoThemeData, useMonacoTheme } from './use-monaco-theme';

const getShikiTheme = vi.fn<(id: string) => Promise<ThemeRegistrationResolved>>();
const captureException = vi.fn();

const codeTheme = (keyword: string) =>
  normalizeTheme({
    type: 'dark',
    fg: '#ffffff',
    bg: '#000000',
    settings: [{ scope: 'keyword', settings: { foreground: keyword } }],
  });

function deferred() {
  let resolve!: (theme: ThemeRegistrationResolved) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ThemeRegistrationResolved>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const lastRules = () => monaco.editor.defineTheme.mock.lastCall?.[1].rules;

const colors = derivePalette({ background: '#050505', accent: '#a78bfa' });
const stockDark: ActivePalette = {
  themeId: 'frink',
  appearance: 'dark',
  syntax: 'github-dark',
  colors,
  stock: true,
  inline: false,
};
const customLight: ActivePalette = {
  themeId: 'sprinkles',
  appearance: 'light',
  syntax: 'github-light',
  colors: derivePalette({ background: '#fff7fa', accent: '#c2185b' }),
  stock: false,
  inline: true,
};

// The real @monaco-editor/loader adopts window.monaco instead of fetching the editor.
const monaco = { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } };
Object.assign(window, { monaco });

function renderTheme(store: ReturnType<typeof createStore>) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store }, children);
  return renderHook(() => useMonacoTheme({ loadTheme: getShikiTheme, report: captureException }), {
    wrapper,
  });
}

/** Resolves tokens as Monaco's standalone theme service does for this theme data. */
function editorTokens(data: ReturnType<typeof monacoThemeData>) {
  const base = data.inherit ? (data.base === 'vs' ? vs : vs_dark).rules : [];
  const theme = TokenTheme.createFromRawTokenTheme(
    [
      ...base.map((rule: MonacoTokenRule) => ({ ...rule })),
      { token: '', foreground: data.colors['editor.foreground'] },
      ...data.rules,
    ],
    [],
  );
  const colours = theme.getColorMap();
  return (token: string) => {
    const rule = theme._match(token);
    return { colour: `${colours[rule._foreground]}`.toLowerCase(), fontStyle: rule._fontStyle };
  };
}

async function editorTokensFor(id: BundledTheme) {
  const theme = normalizeTheme((await bundledThemes[id]()).default);
  const palette: ActivePalette = {
    ...stockDark,
    appearance: theme.type === 'light' ? 'light' : 'dark',
    syntax: id,
  };
  return editorTokens(monacoThemeData(palette, shikiThemeToMonacoRules(theme)));
}

describe('monacoThemeData', () => {
  it('builds a theme Monaco accepts from every bundled code theme', async () => {
    // SAFETY: bundledThemes is a Record keyed by BundledTheme, so its keys are exactly those ids.
    for (const id of Object.keys(bundledThemes) as BundledTheme[]) {
      await expect(editorTokensFor(id), id).resolves.toBeTypeOf('function');
    }
  });

  it.each(['github-dark', 'github-light', 'one-dark-pro', 'horizon', 'min-light'] as const)(
    'resolves editor tokens in %s to the colours a chat code block gives the same code',
    async (id) => {
      const resolve = await editorTokensFor(id);
      const json = '{"name": "frink", "count": 3, "ok": true}';
      const ts = '// note\nclass Foo {}\nconst s = "hi" + 42 + 0xff;\nif (s) return;';
      const samples = [
        ['json', json, 'string.key.json', 'name'],
        ['json', json, 'string.value.json', 'frink'],
        ['json', json, 'number.json', '3'],
        ['json', json, 'keyword.json', 'true'],
        ['typescript', ts, 'comment.ts', '// note'],
        ['typescript', ts, 'type.identifier.ts', 'Foo'],
        ['typescript', ts, 'keyword.ts', 'const'],
        ['typescript', ts, 'keyword.ts', 'return'],
        ['typescript', ts, 'string.ts', 'hi'],
        ['typescript', ts, 'number.ts', '42'],
        ['typescript', ts, 'number.hex.ts', '0xff'],
      ] as const;

      for (const [lang, code, token, text] of samples) {
        const { tokens } = await codeToTokens(code, { lang, theme: id });
        const chat = tokens
          .flat()
          .find((t) => t.content.includes(text))
          ?.color?.toLowerCase()
          // Monaco paints token colours opaque, so only the RGB part can match.
          .slice(0, 7);
        expect(resolve(token).colour, `${token} (${text})`).toBe(chat);
      }
    },
  );

  it("keeps a code theme's explicit fontStyle reset so a nested scope is not italic", () => {
    const rules = shikiThemeToMonacoRules(
      normalizeTheme({
        type: 'light',
        fg: '#000000',
        bg: '#ffffff',
        settings: [
          { scope: 'comment', settings: { fontStyle: 'italic' } },
          { scope: 'comment.line', settings: { fontStyle: '' } },
        ],
      }),
    );
    const resolve = editorTokens(monacoThemeData(customLight, rules));

    expect(resolve('comment.block').fontStyle).toBe(1);
    expect(resolve('comment.line').fontStyle).toBe(0);
  });

  it("keeps stock Frink's own editor chrome at contrast 100", () => {
    expect(monacoThemeData(stockDark, [])).toMatchObject({
      base: 'vs-dark',
      colors: {
        'editorLineNumber.foreground': '#4A4A4A',
        'editor.selectionBackground': '#A78BFA40',
      },
    });
    expect(monacoThemeData({ ...stockDark, appearance: 'light' }, []).colors).toMatchObject({
      'editor.selectionBackground': '#7c3aed33',
    });
  });

  it('paints the editor from the palette once it is written inline', () => {
    const data = monacoThemeData({ ...stockDark, inline: true }, []);

    expect(data.colors['editorLineNumber.foreground']).toBe(colors.mutedText);
    expect(data.colors['editor.background']).toBe(colors.background);
  });
});

describe('useMonacoTheme', () => {
  beforeEach(() => {
    monaco.editor.defineTheme.mockClear();
    monaco.editor.setTheme.mockClear();
    getShikiTheme.mockReset().mockResolvedValue(codeTheme('#ff0000'));
  });

  // Runs first: the loader only resolves asynchronously until it has adopted an instance.
  it('applies the committed palette once Monaco finishes loading', async () => {
    const store = createStore();
    store.set(activePaletteAtom, stockDark);
    renderTheme(store);

    expect(monaco.editor.setTheme).not.toHaveBeenCalled();
    await waitFor(() => expect(monaco.editor.setTheme).toHaveBeenCalledWith('frink-dark'));
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      'frink-dark',
      monacoThemeData(stockDark, []),
    );
  });

  it('leaves Monaco alone until a palette is committed', () => {
    const { result } = renderTheme(createStore());

    expect(result.current).toBe('frink-dark');
    expect(monaco.editor.defineTheme).not.toHaveBeenCalled();
    expect(monaco.editor.setTheme).not.toHaveBeenCalled();
  });

  it('defines the theme before switching every editor to it', () => {
    const store = createStore();
    const { result } = renderTheme(store);

    act(() => store.set(activePaletteAtom, stockDark));

    expect(result.current).toBe('frink-dark');
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      'frink-dark',
      expect.objectContaining({ base: 'vs-dark' }),
    );
    expect(monaco.editor.defineTheme.mock.invocationCallOrder[0]).toBeLessThan(
      monaco.editor.setTheme.mock.invocationCallOrder[0],
    );
  });

  it('redefines the editor chrome when the palette changes within one appearance', () => {
    const store = createStore();
    store.set(activePaletteAtom, stockDark);
    renderTheme(store);
    monaco.editor.defineTheme.mockClear();

    act(() => store.set(activePaletteAtom, { ...stockDark, inline: true }));

    expect(monaco.editor.defineTheme).toHaveBeenLastCalledWith(
      'frink-dark',
      expect.objectContaining({
        colors: expect.objectContaining({ 'editor.background': colors.background }),
      }),
    );
  });

  it("names the theme after the palette's appearance and leaves every pane on it", () => {
    const store = createStore();
    store.set(activePaletteAtom, stockDark);
    const first = renderTheme(store);
    const second = renderTheme(store);

    act(() => store.set(activePaletteAtom, customLight));

    expect(first.result.current).toBe('frink-light');
    expect(second.result.current).toBe('frink-light');
    expect(monaco.editor.defineTheme).toHaveBeenLastCalledWith(
      'frink-light',
      expect.objectContaining({ base: 'vs', colors: monacoThemeData(customLight, []).colors }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('frink-light');
  });

  it("paints the code theme's rules once it loads, and reuses them for a chrome-only commit", async () => {
    const load = deferred();
    getShikiTheme.mockReturnValue(load.promise);
    const store = createStore();
    renderTheme(store);
    const dracula: ActivePalette = { ...stockDark, syntax: 'dracula' };

    act(() => store.set(activePaletteAtom, dracula));
    expect(lastRules()).toEqual([]);
    load.resolve(codeTheme('#ff0000'));
    await waitFor(() =>
      expect(lastRules()).toContainEqual({ token: 'keyword', foreground: '#ff0000' }),
    );

    act(() => store.set(activePaletteAtom, { ...dracula, inline: true }));
    expect(lastRules()).toContainEqual({ token: 'keyword', foreground: '#ff0000' });
    expect(getShikiTheme).toHaveBeenCalledTimes(1);
  });

  it('never lets a slow load overwrite a newer commit', async () => {
    const slow = deferred();
    const fast = deferred();
    getShikiTheme.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const store = createStore();
    renderTheme(store);

    act(() => store.set(activePaletteAtom, { ...stockDark, syntax: 'nord' }));
    act(() => store.set(activePaletteAtom, { ...stockDark, syntax: 'monokai' }));
    fast.resolve(codeTheme('#00ff00'));
    await waitFor(() =>
      expect(lastRules()).toContainEqual({ token: 'keyword', foreground: '#00ff00' }),
    );
    slow.resolve(codeTheme('#ff0000'));
    await act(() => slow.promise);

    expect(lastRules()).toContainEqual({ token: 'keyword', foreground: '#00ff00' });
  });

  it('keeps the chrome-only theme on a failed load and retries on the next commit', async () => {
    const error = new Error('chunk failed');
    getShikiTheme.mockRejectedValueOnce(error);
    const store = createStore();
    renderTheme(store);
    const vesper: ActivePalette = { ...stockDark, syntax: 'vesper' };

    act(() => store.set(activePaletteAtom, vesper));
    await waitFor(() => expect(captureException).toHaveBeenCalledWith(error, expect.anything()));
    expect(lastRules()).toEqual([]);

    act(() => store.set(activePaletteAtom, { ...vesper, inline: true }));
    await waitFor(() =>
      expect(lastRules()).toContainEqual({ token: 'keyword', foreground: '#ff0000' }),
    );
  });
});
