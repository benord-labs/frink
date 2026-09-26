/**
 * Frink's notification sound family — seven synthesized sounds grown from one
 * brand motif: the octave leap of the original E5→E6 chime. Hierarchy comes
 * from how far the motif extends (a flick, a leap, a dotted rise, a weighted
 * landing); failure is the family's only dissonance. Full spec + the design
 * workbench that produced it: docs/sound-lab/.
 *
 * Voice: pure sine, hard onset, exponential release. A 4% reverb send into a
 * generated impulse adds room; "shimmer" layers a +6-cent voice at 0.4× gain.
 */

export type SoundName =
  | 'started'
  | 'turnComplete'
  | 'flowComplete'
  | 'batchDone'
  | 'needsYou'
  | 'parked'
  | 'failed';

type SoundOptions = {
  /** Linear gain 0..1 applied on top of each note's designed gain. */
  volume?: number;
};

/** hz @ `at` seconds from onset, `dur` seconds, designed gain 0..1. */
type Note = { hz: number; at: number; dur: number; gain: number };

type Gesture = { notes: Note[]; shimmer: boolean };

const GESTURES: Record<SoundName, Gesture> = {
  // The motif, flicked. In the library but unwired in-app: the away-rule
  // would keep a start cue near-permanently silent (you are almost always
  // viewing, focused, the run you just started).
  started: {
    shimmer: false,
    notes: [
      { hz: 329.63, at: 0, dur: 0.12, gain: 0.35 },
      { hz: 659.25, at: 0.04, dur: 0.2, gain: 0.4 },
    ],
  },
  // The warm leap: the octave moved down to A so the most-played sound sits
  // in the least fatiguing register.
  turnComplete: {
    shimmer: false,
    notes: [
      { hz: 440, at: 0, dur: 0.4, gain: 0.9 },
      { hz: 880, at: 0.13, dur: 0.45, gain: 1 },
    ],
  },
  // Dotted da…da-DUM — a breath before the arrival.
  flowComplete: {
    shimmer: true,
    notes: [
      { hz: 659.25, at: 0, dur: 0.3, gain: 0.8 },
      { hz: 987.77, at: 0.22, dur: 0.25, gain: 0.85 },
      { hz: 1318.51, at: 0.31, dur: 0.55, gain: 1 },
    ],
  },
  // The leap, landed: bigger by weight and width, never by altitude — the
  // E6 restruck with the fifth under it over a held low root.
  batchDone: {
    shimmer: false,
    notes: [
      { hz: 329.63, at: 0, dur: 1.1, gain: 0.5 },
      { hz: 659.25, at: 0, dur: 0.3, gain: 0.85 },
      { hz: 1318.51, at: 0.09, dur: 0.35, gain: 0.9 },
      { hz: 1318.51, at: 0.28, dur: 0.7, gain: 1 },
      { hz: 987.77, at: 0.28, dur: 0.7, gain: 0.5 },
    ],
  },
  // The doubled knock — repetition asks.
  needsYou: {
    shimmer: true,
    notes: [
      { hz: 440, at: 0, dur: 0.13, gain: 1 },
      { hz: 440, at: 0.16, dur: 0.13, gain: 1 },
    ],
  },
  // Descends but only to the fifth — suspended, not finished.
  parked: {
    shimmer: false,
    notes: [
      { hz: 1318.51, at: 0, dur: 0.35, gain: 0.5 },
      { hz: 987.77, at: 0.21, dur: 0.6, gain: 0.45 },
    ],
  },
  // Uh-uh: low, falling, and semitone-sour — the family's only dissonance,
  // so it cannot be mistaken for any success sound.
  failed: {
    shimmer: true,
    notes: [
      { hz: 220, at: 0, dur: 0.2, gain: 0.85 },
      { hz: 233.08, at: 0, dur: 0.2, gain: 0.4 },
      { hz: 174.61, at: 0.1, dur: 0.45, gain: 0.95 },
      { hz: 185, at: 0.1, dur: 0.45, gain: 0.45 },
    ],
  },
};

const SHIMMER_CENTS = 6;
const SHIMMER_GAIN = 0.4;
const REVERB_SEND = 0.04;

// Coalesce bursts (parallel agent turns finishing together, a fan-out raising
// several prompts at once) into one audible event. Per sound — a failure must
// never be swallowed by a completion that happened to play just before it.
// Every event still surfaces its own toast, so coalescing only drops
// duplicate dings, never information.
const COOLDOWN_MS = 2000;
const lastPlayedAt = new Map<SoundName, number>();

let audioCtx: AudioContext | null = null;
let reverbSend: GainNode | null = null;

/** ~1.7s of exponentially decaying noise — a small, neutral room. */
function makeImpulse(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 1.7);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3.4;
    }
  }
  return buffer;
}

function ensureGraph(): AudioContext {
  // A context can die under the app (audio device churn, OS audio reset) —
  // a cached 'closed' context would silence every sound until app restart.
  if (audioCtx?.state === 'closed') {
    audioCtx = null;
    reverbSend = null;
  }
  if (!audioCtx) {
    audioCtx = new AudioContext();
    const convolver = audioCtx.createConvolver();
    convolver.buffer = makeImpulse(audioCtx);
    convolver.connect(audioCtx.destination);
    reverbSend = audioCtx.createGain();
    reverbSend.gain.value = REVERB_SEND;
    reverbSend.connect(convolver);
  }
  return audioCtx;
}

function playVoice(ctx: AudioContext, note: Note, volume: number, detuneCents: number): void {
  const t = ctx.currentTime + note.at;
  const peak = Math.max(note.gain * volume, 0.0004);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(note.hz, t);
  if (detuneCents !== 0) osc.detune.setValueAtTime(detuneCents, t);
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(peak * 0.001, t + note.dur);

  osc.connect(gain);
  gain.connect(ctx.destination);
  if (reverbSend) gain.connect(reverbSend);
  osc.start(t);
  osc.stop(t + note.dur);
}

/**
 * Play one family sound. Bursts within the per-sound cooldown coalesce into a
 * single play; a failed attempt (no user gesture yet, audio denied) releases
 * its cooldown claim so the next attempt is not silently swallowed.
 */
export async function playSound(
  name: SoundName,
  { volume = 1.0 }: SoundOptions = {},
): Promise<void> {
  // Claim the cooldown synchronously (before any await) so a same-tick burst
  // coalesces even while the context is still resuming.
  const attemptAt = Date.now();
  if (attemptAt - (lastPlayedAt.get(name) ?? 0) < COOLDOWN_MS) return;
  lastPlayedAt.set(name, attemptAt);
  // Clamp to the documented 0..1 — an out-of-range caller must not produce a
  // 9-figure gain spike or a negative-gain throw.
  const clampedVolume = Math.min(Math.max(volume, 0), 1);
  try {
    const ctx = ensureGraph();
    if (ctx.state === 'suspended') await ctx.resume();
    const gesture = GESTURES[name];
    for (const note of gesture.notes) {
      playVoice(ctx, note, clampedVolume, 0);
      if (gesture.shimmer) {
        playVoice(ctx, { ...note, gain: note.gain * SHIMMER_GAIN }, clampedVolume, SHIMMER_CENTS);
      }
    }
  } catch {
    // Audio unavailable (no user gesture, denied permissions, suspended ctx).
    if (lastPlayedAt.get(name) === attemptAt) lastPlayedAt.delete(name);
  }
}
