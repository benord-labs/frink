/** How long Frink takes to assemble out of the time rift, and to burst back into it. */
export const WARP_IN_MS = 1300;
export const WARP_OUT_MS = 1100;

export const WALK_SPEED = 2.5;
export const FRAME_INTERVAL_MS = 160;
export const PAUSE_X_RATIO = 0.38;
export const BUBBLE_SHOW_MS = 2800;
export const REACTION_SHOW_MS = 3500;
export const WALKOUT_DELAY_MS = 1200;
/** Backstop that sends Frink on to his reaction if the board never finishes. */
export const MAX_SUMMONING_MS = 30000;
export const EXIT_COMPLETE_DELAY_MS = 600;

export const SPEECH_QUIPS = [
  '∂Ψ/∂t = iℏ⁻¹Ĥ... fascinating.',
  '∮ E⃗·dA⃗ = Q/ε₀ — flux is nominal!',
  '⌬∇²φ + k²φ = 0... interesting topology.',
  'Σ(n→∞) aₙxⁿ... the series converges!',
  '∫∫∫ ρ dV = M... mass checks out.',
  '▽ × B⃗ = μ₀J⃗ + ∂E⃗/∂t — glayvin!',
  '𝒵 = Tr(e^{-βĤ})... partition function nominal.',
];

export const REACTION_QUIPS = [
  'Hmm... interesting...',
  'Fascinating results...',
  'The data speaks for itself!',
  'As I suspected — glayvin!',
  'Most illuminating...',
  'The hypothesis holds!',
];

/** What Frink says when poked during HELPFRINK; the third poke sends him off. */
export const POKE_QUIPS = [
  'Ow! Hoyvin-mayvin!',
  'Please, I am a professor!',
  'Do not poke the scientist!',
  'Glayvin! That tickles!',
];
export const POKES_TO_LEAVE = 3;
export const POKE_LAST_STRAW = "Fine! I know when I'm not wanted.";
export const POKE_QUIP_MS = 1500;

/** Voxel Frink's height in the cameo and chaser walk-bys, in CSS px. */
export const WALK_BY_HEIGHT = 120;
/** How long the MascotCameo holds the silent '...' bubble before walking off. */
export const CAMEO_PAUSE_MS = 1800;
/** A cameo with a line holds long enough to read it. */
export const CAMEO_LINE_PAUSE_MS = 4000;
