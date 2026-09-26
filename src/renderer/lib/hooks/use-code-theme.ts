import { useAtomValue } from 'jotai';
import { activePaletteAtom, codeThemeAtom } from '../themes/palette/theme-atoms';

/** Shiki theme name for code: the committed palette's syntax pairing. */
export function useCodeTheme(): string {
  return useAtomValue(codeThemeAtom);
}

/** Whether code renders light: the committed palette's, so it pairs with `useCodeTheme`. */
export function useIsLightCode(): boolean {
  return useAtomValue(activePaletteAtom)?.appearance === 'light';
}
