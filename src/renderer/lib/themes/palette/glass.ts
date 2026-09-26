import type { Appearance } from './roles';

/** Transparency slider scale, in percent. The default row is Standard. */
export const TRANSPARENCY_SCALE = { min: 0, max: 100, step: 25, default: 50 } as const;

// Fill opacity (%) and backdrop filter per Transparency step, Solid to See-through. Solid uses
// `none`, never blur(0): any filter creates a containing block and stacking context.
const GLASS_ROWS = [
  [100, 'none'],
  [85, 'blur(10px) saturate(1.4)'],
  [70, 'blur(8px) saturate(1.6)'],
  [55, 'blur(6px) saturate(1.8)'],
  [40, 'blur(5px) saturate(1.8)'],
] as const;

/** Frink Glass (`glass-lit`) alphas per step: white rim, white inner sheen, primary glint. */
const LIT = {
  light: [
    [0, 0, 0],
    [0.55, 0.18, 0.06],
    [0.65, 0.24, 0.08],
    [0.75, 0.3, 0.1],
    [0.85, 0.36, 0.12],
  ],
  dark: [
    [0, 0, 0],
    [0.14, 0.04, 0.1],
    [0.19, 0.05, 0.13],
    [0.25, 0.07, 0.16],
    [0.3, 0.08, 0.19],
  ],
} as const satisfies Record<Appearance, readonly (readonly [number, number, number])[]>;

/**
 * Glass vars for a transparency level (snapped to the nearest step): the one glass material's fill
 * opacity and backdrop filter, and Frink Glass. The background behind it never changes with the level.
 */
export function glassVars(level: number, appearance: Appearance) {
  const step = Math.round(Math.min(100, Math.max(0, level)) / TRANSPARENCY_SCALE.step);
  const [opacity, filter] = GLASS_ROWS[step];
  const [rim, sheen, tint] = LIT[appearance][step];
  return {
    '--glass-opacity': `${opacity}%`,
    '--glass-filter': filter,
    '--glass-rim': String(rim),
    '--glass-sheen': String(sheen),
    '--glass-tint': String(tint),
    // Secondary ink moves toward primary ink as the glass clears.
    '--glass-ink': `${7.5 * step}%`,
  };
}
