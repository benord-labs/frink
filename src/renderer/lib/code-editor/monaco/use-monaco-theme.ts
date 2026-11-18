import { useMonaco } from '@monaco-editor/react';
import * as Sentry from '@sentry/electron/renderer';
import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import type { ActivePalette } from '@/lib/themes/palette/apply';
import type { Appearance, Palette } from '@/lib/themes/palette/roles';
import { activePaletteAtom } from '@/lib/themes/palette/theme-atoms';
import { getShikiTheme } from '@/lib/themes/shiki-theme-loader';
import { type MonacoTokenRule, shikiThemeToMonacoRules } from './shiki-theme-to-monaco';

/** The vs/vs-dark chrome Monaco filled in while the theme inherited its base, pinned unchanged. */
const MONACO_BASE_COLORS = {
  dark: {
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editor.selectionHighlightBackground': '#ADD6FF26',
  },
  light: {
    'editor.inactiveSelectionBackground': '#E5EBF1',
    'editorIndentGuide.background1': '#D3D3D3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editor.selectionHighlightBackground': '#ADD6FF4D',
  },
} satisfies Record<Appearance, Record<string, string>>;

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

/** Monaco theme data: the code theme's token rules over the editor chrome (stock Frink's own at contrast 100). */
export function monacoThemeData(palette: ActivePalette, rules: MonacoTokenRule[]) {
  return {
    base: palette.appearance === 'dark' ? ('vs-dark' as const) : ('vs' as const),
    // Not inherited: the base's stock token colours would out-rank the code theme's.
    inherit: false,
    rules,
    colors: {
      ...MONACO_BASE_COLORS[palette.appearance],
      ...(palette.inline ? editorColors(palette.colors) : FRINK_EDITOR_COLORS[palette.appearance]),
    },
  };
}

const rulesBySyntax = new Map<string, MonacoTokenRule[]>();

type ThemeLoading = {
  loadTheme?: typeof getShikiTheme;
  report?: typeof Sentry.captureException;
};

/**
 * Monaco theme name for the committed palette. 'frink-light'/'frink-dark' are redefined on each
 * commit (never per preview frame), which refreshes every editor already using them.
 */
export function useMonacoTheme({
  loadTheme = getShikiTheme,
  report = Sentry.captureException,
}: ThemeLoading = {}): string {
  const monaco = useMonaco();
  const palette = useAtomValue(activePaletteAtom);
  const name = palette?.appearance === 'light' ? 'frink-light' : 'frink-dark';

  useEffect(() => {
    if (!monaco || !palette) return;
    let cancelled = false;
    const apply = (rules: MonacoTokenRule[]) => {
      monaco.editor.defineTheme(name, monacoThemeData(palette, rules));
      // An editor that mounted before this theme existed fell back to 'vs'.
      monaco.editor.setTheme(name);
    };
    const loadRules = async () => {
      try {
        const rules = shikiThemeToMonacoRules(await loadTheme(palette.syntax));
        rulesBySyntax.set(palette.syntax, rules);
        if (!cancelled) apply(rules);
      } catch (error) {
        report(error, { tags: { surface: 'monaco-theme' } });
      }
    };
    const cached = rulesBySyntax.get(palette.syntax);
    // Chrome first, so no editor waits on the code theme's first load in plain 'vs'.
    apply(cached ?? []);
    if (!cached) void loadRules();
    return () => {
      cancelled = true;
    };
  }, [monaco, palette, name, loadTheme, report]);

  return name;
}
