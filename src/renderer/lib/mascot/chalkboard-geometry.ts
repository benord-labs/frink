/**
 * Layout for the chalkboard Frink writes on during a summon, in the board's SVG
 * units. The maths is whimsical except where real repo stats are passed in.
 */

export const BOARD_VIEWBOX = { width: 424, height: 214 } as const;
/** Rendered board width in CSS px, frame included. */
export const BOARD_WIDTH = 420;
export const BOARD_FRAME = 8;
const LEDGE = 14;
/** The whole drawing: slate plus the wooden frame and the chalk ledge under it. */
export const BOARD_OUTER = {
  width: BOARD_VIEWBOX.width + 2 * BOARD_FRAME,
  height: BOARD_VIEWBOX.height + 2 * BOARD_FRAME + LEDGE,
} as const;

/** Illustration pigments, like the voxel colours; not app theme tokens. */
export const BOARD_PAINT = {
  wood: '#5a3d27',
  woodDark: '#3e2a1b',
  slate: '#1b2824',
  chalk: '#f1efe6',
  eraser: '#8a6d4e',
  felt: '#c9c2b0',
} as const;

export type BoardLine = { text: string; x: number; y: number; size: number };

/** Diffstat of the summoned project's recent commits. */
export type BoardStats = { commits: number; insertions: number; deletions: number };

/** Four lines of working, then the answer Frink circles once the agent starts replying.
 * Real stats replace the second line only: the first is already being written when they land. */
export function boardLines(stats?: BoardStats | null): BoardLine[] {
  const working = [
    'let Δ = git log −10',
    stats ? `∂code/∂t = +${stats.insertions} − ${stats.deletions}` : '∂code/∂t > 0',
    '∮ tests · dA → coverage',
    'Σ ideas ÷ Σ bugs → ∞ ?',
  ];
  return [
    ...working.map((text, i) => ({ text, x: 24, y: 40 + i * 32, size: 18 })),
    { text: '∴ review!', x: 150, y: 180, size: 26 },
  ];
}

export const ANSWER_INDEX = 4;

type Box = { x: number; y: number; width: number; height: number };

/** A hand-drawn loop slightly more than once around `box`, as an SVG path. */
export function ringPath(box: Box): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 + 2;
  const rx = box.width / 2 + 20;
  const ry = box.height / 2 + 6;
  const points: string[] = [];
  for (let i = 0; i <= 70; i++) {
    const angle = -2.4 + (i / 70) * Math.PI * 2.18;
    const wobble = 1 + Math.sin(i * 0.9) * 0.025 + i * 0.0009;
    points.push(
      `${(cx + Math.cos(angle) * rx * wobble).toFixed(1)},${(cy + Math.sin(angle) * ry * wobble).toFixed(1)}`,
    );
  }
  return `M${points.join(' L')}`;
}
