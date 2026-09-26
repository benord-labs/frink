// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivePalette } from '@/lib/themes/palette/apply';
import { derivePalette } from '@/lib/themes/palette/derive';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';
import { monacoThemeData, useMonacoTheme } from './use-monaco-theme';

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
  return renderHook(() => useMonacoTheme(), { wrapper });
}

describe('monacoThemeData', () => {
  it("keeps stock Frink's own editor chrome at contrast 100", () => {
    expect(monacoThemeData(stockDark)).toMatchObject({
      base: 'vs-dark',
      colors: {
        'editorLineNumber.foreground': '#4A4A4A',
        'editor.selectionBackground': '#A78BFA40',
      },
    });
    expect(monacoThemeData({ ...stockDark, appearance: 'light' }).colors).toMatchObject({
      'editor.selectionBackground': '#7c3aed33',
    });
  });

  it('paints the editor from the palette once it is written inline', () => {
    const data = monacoThemeData({ ...stockDark, inline: true });

    expect(data.colors['editorLineNumber.foreground']).toBe(colors.mutedText);
    expect(data.colors['editor.background']).toBe(colors.background);
  });
});

describe('useMonacoTheme', () => {
  beforeEach(() => {
    monaco.editor.defineTheme.mockClear();
    monaco.editor.setTheme.mockClear();
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
      monacoThemeData(stockDark),
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
      monacoThemeData(stockDark),
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
      monacoThemeData(customLight),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('frink-light');
  });
});
