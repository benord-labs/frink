import { contrastRatio, isDarkColor, toOklch } from '../palette/color';
import { AA_FLOOR, solveLightness } from '../palette/derive';

/** Imported colours are held to the same readability floor as derived ones. */
export function readsOn(color: string, surfaces: readonly string[]): boolean {
  return surfaces.every((surface) => contrastRatio(color, surface) >= AA_FLOOR);
}

/** `accent` as is when it reads on `background`, else lightened (dark) or darkened (light) until it does. */
export function readableAccent(accent: string, background: string): string {
  if (readsOn(accent, [background])) return accent;
  return solveLightness(toOklch(accent), [background], AA_FLOOR, isDarkColor(background));
}
