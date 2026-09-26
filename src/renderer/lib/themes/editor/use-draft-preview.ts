import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useTheme } from 'next-themes';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { holdThemeSwitching, paintStoredTheme } from '../paint-theme';
import { type ActivePalette, applyGlass, applyPalette } from '../palette/apply';
import { applyContrast } from '../palette/contrast';
import { derivePalette } from '../palette/derive';
import type { Appearance, Palette } from '../palette/roles';
import {
  activePaletteAtom,
  contrastAtom,
  previewActiveAtom,
  transparencyAtom,
} from '../palette/theme-atoms';
import type { Half } from '../palette/theme-schema';

// Terminal and Monaco rebuild on every commit, so they get the draft once it settles.
const COMMIT_IDLE_MS = 250;

type DraftFrame = {
  themeId: string;
  derived: Palette;
  syntax: Half['syntax'];
  appearance: Appearance;
  contrast: number;
  transparency: number;
};

function setAppearanceClass(appearance: string | undefined): void {
  const { classList } = document.documentElement;
  classList.toggle('dark', appearance === 'dark');
  classList.toggle('light', appearance === 'light');
}

/** Paints one draft frame; every <html> write lands in the same task. */
function paintDraft({
  themeId,
  derived,
  syntax,
  appearance,
  contrast,
  transparency,
}: DraftFrame): ActivePalette {
  const active: ActivePalette = {
    themeId,
    appearance,
    syntax,
    colors: applyContrast(derived, contrast),
    stock: false,
    inline: true,
  };
  holdThemeSwitching();
  setAppearanceClass(appearance);
  applyPalette(active);
  applyGlass(transparency, appearance);
  return active;
}

/** Unless `suspended`, owns <html>: paints the draft half without telling next-themes and returns
 * its pre-contrast palette. Suspended or unmounted, it hands <html> back with the stored theme. */
export function useDraftPreview(
  themeId: string,
  half: Half,
  appearance: Appearance,
  suspended: boolean,
): Palette {
  const contrast = useAtomValue(contrastAtom);
  const transparency = useAtomValue(transparencyAtom);
  const setPreviewActive = useSetAtom(previewActiveAtom);
  const setActivePalette = useSetAtom(activePaletteAtom);
  const store = useStore();
  const { resolvedTheme } = useTheme();
  const resolvedRef = useRef(resolvedTheme);
  const derived = useMemo(() => derivePalette(half), [half]);

  useLayoutEffect(() => {
    resolvedRef.current = resolvedTheme;
  }, [resolvedTheme]);

  useLayoutEffect(() => {
    if (suspended) return;
    setPreviewActive(true);
    return () => {
      setAppearanceClass(resolvedRef.current);
      paintStoredTheme(store);
      setPreviewActive(false);
    };
  }, [suspended, store, setPreviewActive]);

  // next-themes writes its class in a passive effect (e.g. a scheme change from another window),
  // after any effect here, so the draft's class is re-asserted once the write lands.
  useLayoutEffect(() => {
    if (suspended) return;
    const { classList } = document.documentElement;
    const observer = new MutationObserver(() => {
      if (classList.contains('dark') !== (appearance === 'dark')) setAppearanceClass(appearance);
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [suspended, appearance]);

  useLayoutEffect(() => {
    if (suspended) return;
    const frame = { themeId, derived, syntax: half.syntax, appearance, contrast, transparency };
    const active = paintDraft(frame);
    const timer = setTimeout(() => setActivePalette(active), COMMIT_IDLE_MS);
    return () => clearTimeout(timer);
  }, [
    suspended,
    themeId,
    derived,
    half.syntax,
    appearance,
    contrast,
    transparency,
    setActivePalette,
  ]);

  return derived;
}
