import { ANSWER_INDEX } from './chalkboard-geometry';
import { assertLive, type CancelToken, SequenceCancelled, wait } from './timeline';
import type { FrinkBuild, FrinkPose } from './voxel-frink-model';

type Point = { x: number; y: number };

/** What the proof needs from the on-screen chalkboard. */
export type ChalkboardControls = {
  unroll: (token: CancelToken, reducedMotion: boolean) => Promise<void>;
  /** Writes one line left to right, reporting where the chalk touches in viewport px. */
  write: (index: number, token: CancelToken, onTip: (at: Point) => void) => Promise<void>;
  /** Shows the first `count` lines at once (reduced motion). */
  reveal: (count: number) => void;
  circleAnswer: (token: CancelToken, reducedMotion: boolean) => Promise<void>;
  /** Rolls the board up once the proof is done. */
  rollUp: () => void;
  /** Quietly fades the board (the summon was dismissed first). */
  fadeOut: () => void;
};

export type ChalkboardProof = {
  board: ChalkboardControls;
  token: CancelToken;
  reducedMotion: boolean;
  setPose: (pose: FrinkPose) => void;
  /** Where the chalk in Frink's hand must touch; null lets him drift home. */
  follow: (at: Point | null) => void;
};

/** A beat after each written line, so it can be read before the next one starts. */
const LINE_PAUSE_MS = 450;
/** How long the circled answer stays up before the board rolls away. */
const ANSWER_HOLD_MS = 2500;
/** Reduced motion shows every line at once, so the reading time moves to the hold. */
const REVEALED_HOLD_MS = 6000;

async function writeLines(proof: ChalkboardProof, start: number, end: number) {
  const { board, token, reducedMotion, setPose, follow } = proof;
  assertLive(token);
  if (reducedMotion) {
    board.reveal(end);
    return;
  }
  setPose('write');
  for (let i = start; i < end; i++) {
    await board.write(i, token, follow);
    await wait(LINE_PAUSE_MS, token);
  }
  follow(null);
}

async function playProof(proof: ChalkboardProof): Promise<void> {
  const { board, token, reducedMotion, setPose } = proof;
  await board.unroll(token, reducedMotion);
  await writeLines(proof, 0, ANSWER_INDEX);
  setPose('stand');
  await wait(LINE_PAUSE_MS, token);
  await writeLines(proof, ANSWER_INDEX, ANSWER_INDEX + 1);
  setPose('cheer');
  await board.circleAnswer(token, reducedMotion);
  await wait(reducedMotion ? REVEALED_HOLD_MS : ANSWER_HOLD_MS, token);
  setPose('stand');
  board.rollUp();
}

/** Frink's chalkboard routine. Resolves true once the board is rolled up, false
 * when the summon was dismissed first. */
export async function runChalkboardProof(proof: ChalkboardProof): Promise<boolean> {
  try {
    await playProof(proof);
    return true;
  } catch (error) {
    if (error instanceof SequenceCancelled) return false;
    throw error;
  }
}

export type SummonPhase = 'walk-in' | 'speak' | 'summoning' | 'reacting' | 'walk-out' | 'done';

/** The pose a phase change calls for; null leaves the current pose alone. */
export function poseForPhase(phase: SummonPhase): FrinkPose | null {
  if (phase === 'reacting') return 'cheer';
  if (phase === 'walk-out') return 'stand';
  return null;
}

/** How the voxel model should look in each summon phase. */
export function frinkBuildFor(phase: SummonPhase, reducedMotion: boolean): FrinkBuild {
  const leaving = phase === 'walk-out' || phase === 'done';
  if (reducedMotion) return leaving ? 'hidden' : 'solid';
  return leaving ? 'explode' : 'assemble';
}

export type GlideStep = {
  pos: Point;
  home: Point;
  /** Where the chalk must touch, or null when Frink is not writing. */
  follow: Point | null;
  /** The chalk tip relative to Frink's box, from the last rendered frame. */
  tip: Point | null;
  dt: number;
};

/** Moves Frink one frame toward the chalk point while writing (never below the
 * floor, so high lines make him hover), else back home. */
export type GlideResult = { pos: Point; lift: number };

export function glideFrink({ pos, home, follow, tip, dt }: GlideStep): GlideResult {
  const writing = follow !== null && tip !== null;
  const target = writing ? { x: follow.x - tip.x, y: Math.min(home.y, follow.y - tip.y) } : home;
  // Snap almost instantly to the chalk; drift home gently.
  const pull = 1 - (writing ? 1e-7 : 0.002) ** dt;
  const next = { x: pos.x + (target.x - pos.x) * pull, y: pos.y + (target.y - pos.y) * pull };
  return { pos: next, lift: home.y - next.y };
}
