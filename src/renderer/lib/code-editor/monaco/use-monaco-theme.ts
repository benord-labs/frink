import { useMonaco } from '@monaco-editor/react';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import type { ActivePalette } from '@/lib/themes/palette/apply';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';

/** VS Code Dark+ token colours for the dark base; light inherits 'vs'. */
const DARK_TOKEN_RULES: Array<{ token: string; foreground?: string; fontStyle?: string }> = [
  { token: 'keyword', foreground: '#C586C0' },
  { token: 'keyword.control', foreground: '#C586C0' },
  { token: 'keyword.operator', foreground: '#C586C0' },
  { token: 'type', foreground: '#4EC9B0' },
  { token: 'type.identifier', foreground: '#4EC9B0' },
  { token: 'class', foreground: '#4EC9B0' },
  { token: 'function', foreground: '#DCDCAA' },
  { token: 'support.function', foreground: '#DCDCAA' },
  { token: 'variable', foreground: '#9CDCFE' },
  { token: 'variable.parameter', foreground: '#9CDCFE' },
  { token: 'constant', foreground: '#4FC1FF' },
  { token: 'string', foreground: '#CE9178' },
  { token: 'string.escape', foreground: '#D7BA7D' },
  { token: 'comment', foreground: '#6A9955', fontStyle: 'italic' },
  { token: 'number', foreground: '#B5CEA8' },
  { token: 'regexp', foreground: '#D16969' },
  { token: 'tag', foreground: '#569CD6' },
  { token: 'attribute.name', foreground: '#9CDCFE' },
  { token: 'attribute.value', foreground: '#CE9178' },
];

/** Stock Frink's editor chrome, kept as it was before themes were palette-driven. */
const FRINK_EDITOR_COLORS = {
  dark: {
    'editor.background': '#050505',
    'editor.foreground': '#E8E8E8',
    'editor.selectionBackground': '#A78BFA40',
    'editor.selectionHighlightBackground': '#A78BFA25',
    'editor.lineHighlightBackground': '#0A0A0A',
    'editorCursor.foreground': '#A78BFA',
    'editorLineNumber.foreground': '#4A4A4A',
    'editorLineNumber.activeForeground': '#8B8B8B',
    'list.activeSelectionBackground': '#141414',
    'list.activeSelectionForeground': '#E8E8E8',
    'list.hoverBackground': '#1A1A1A',
    'list.hoverForeground': '#E8E8E8',
    'list.focusBackground': '#141414',
    'list.inactiveSelectionBackground': '#141414',
    'dropdown.background': '#1A1A1A',
    'dropdown.foreground': '#E8E8E8',
    'dropdown.border': '#2D2D2D',
    'input.background': '#1A1A1A',
    'input.border': '#2D2D2D',
    'input.foreground': '#E8E8E8',
    'input.placeholderForeground': '#8B8B8B',
    focusBorder: '#A78BFA',
  },
  light: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0a0a0a',
    'editor.selectionBackground': '#7c3aed33',
    'editorLineNumber.foreground': '#a1a1aa',
    'list.activeSelectionBackground': '#f4f4f5',
    'list.hoverBackground': '#f4f4f5',
    'dropdown.background': '#ffffff',
    'dropdown.foreground': '#0a0a0a',
    'input.background': '#FAFAFA',
    'input.border': '#e4e4e7',
    'input.foreground': '#0a0a0a',
    focusBorder: '#7c3aed',
  },
} satisfies Record<Appearance, Record<string, string>>;

/** Editor chrome painted with the palette's roles. */
function editorColors(colors: Palette) {
  return {
    'editor.background': colors.background,
    'editor.foreground': colors.text,
    'editor.lineHighlightBackground': colors.sidebar,
    'editor.selectionBackground': `${colors.accent}40`,
    'editorCursor.foreground': colors.accent,
    'editorLineNumber.foreground': colors.mutedText,
    'editorLineNumber.activeForeground': colors.text,
    'editorWidget.background': colors.overlay,
    'editorWidget.border': colors.border,
    focusBorder: colors.accent,
  };
}

/** Monaco theme data: stock Frink at contrast 100 keeps its own chrome, anything else the palette. */
export function monacoThemeData(palette: ActivePalette) {
  const dark = palette.appearance === 'dark';
  return {
    base: dark ? ('vs-dark' as const) : ('vs' as const),
    inherit: true,
    rules: dark ? DARK_TOKEN_RULES : [],
    colors: palette.inline ? editorColors(palette.colors) : FRINK_EDITOR_COLORS[palette.appearance],
  };
}

/**
 * Monaco theme name for the committed palette. 'frink-light'/'frink-dark' are redefined on each
 * commit (never per preview frame), which refreshes every editor already using them.
 */
export function useMonacoTheme(): string {
  const monaco = useMonaco();
  const palette = useAtomValue(activePaletteAtom);
  const name = palette?.appearance === 'light' ? 'frink-light' : 'frink-dark';

  useEffect(() => {
    if (!monaco || !palette) return;
    monaco.editor.defineTheme(name, monacoThemeData(palette));
    // An editor that mounted before this theme existed fell back to 'vs'.
    monaco.editor.setTheme(name);
  }, [monaco, palette, name]);

  return name;
}
