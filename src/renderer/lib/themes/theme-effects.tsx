import { useAtomValue, useStore } from 'jotai';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect } from 'react';
import { holdThemeSwitching, paintTheme, writeBootBackground } from './paint-theme';
import { applyGlass, clearPalette } from './palette/apply';
import {
  activePaletteAtom,
  contrastAtom,
  customThemesAtom,
  previewActiveAtom,
  themeHalvesAtom,
  transparencyAtom,
} from './palette/theme-atoms';

/**
 * Paints the stored theme on <html> for the current appearance and commits it to
 * `activePaletteAtom`. Stands down while the theme editor's preview owns <html>.
 */
export function ThemeEffects({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const appearance = resolvedTheme === 'dark' ? 'dark' : 'light';
  const halves = useAtomValue(themeHalvesAtom);
  const customThemes = useAtomValue(customThemesAtom);
  const contrast = useAtomValue(contrastAtom);
  const transparency = useAtomValue(transparencyAtom);
  const previewActive = useAtomValue(previewActiveAtom);
  const store = useStore();

  useEffect(() => {
    if (previewActive) return;
    const current = store.get(activePaletteAtom);
    store.set(
      activePaletteAtom,
      paintTheme({ halves, customThemes, appearance, contrast }, current),
    );
    writeBootBackground(halves, customThemes);
  }, [previewActive, halves, customThemes, appearance, contrast, store]);

  useEffect(() => {
    if (previewActive) return;
    holdThemeSwitching();
    applyGlass(transparency, appearance);
  }, [previewActive, transparency, appearance]);

  // A stale theme's vars would otherwise outlive it and keep overriding globals.css.
  useEffect(() => clearPalette, []);

  // Wraps rather than renders beside the tree, so theme changes never re-render the App tree.
  return children;
}
