/**
 * Pure decision for which family sound (if any) a flow execution event plays.
 * A Flow chains many agent nodes through one chat; per-node sounds are
 * suppressed (see completion-effects.ts isFlowDriven) and the flow plays at
 * most one sound per lifecycle transition here — gated by the same "away"
 * rule as chat completion (suppress only when viewing the flow AND focused).
 */
import type { SoundName } from './audio/play-chime';

// Deliberately absent: run_cancelled (user action — the toast informs, a
// sound would punish deliberate cleanup) and run_started (the away rule
// would keep a start cue near-permanently silent — you are almost always
// viewing, focused, the run you just started).
const EVENT_SOUNDS = new Map<string, SoundName>([
  ['run_completed', 'flowComplete'],
  ['run_failed', 'failed'],
  ['run_paused', 'parked'],
  ['batch_completed', 'batchDone'],
]);

export type FlowEventSoundArgs = {
  eventType: string;
  /** Present on batch-member run events and on batch_completed itself. */
  batchId?: string | null;
  /** run_paused only: names a wait that is not about the user (see FlowExecutionEvent). */
  pauseKind?: 'user' | 'agent-handoff';
  soundEnabled: boolean;
  isViewingThisFlow: boolean;
  isWindowFocused: boolean;
};

export function flowEventSound(args: FlowEventSoundArgs): SoundName | null {
  if (!args.soundEnabled) return null;
  // Batch members are individually silent — a fan-out's N staggered starts
  // and finishes would defeat the per-sound cooldown. Only the batch's own
  // completion sounds; member toasts still surface each result.
  if (args.batchId && args.eventType !== 'batch_completed') return null;
  // 'parked' announces only a wait that needs YOU. A pauseKind names a wait that doesn't: the
  // user's own Pause click (park → watcher → advance), or the engine waiting on a dispatched
  // agent task — which happens on every node advance.
  if (args.eventType === 'run_paused' && args.pauseKind) return null;
  const sound = EVENT_SOUNDS.get(args.eventType);
  if (!sound) return null;
  // Away rule, mirroring chat completion: a flow you're not actively viewing
  // (or in a backgrounded window) sounds; one you're watching stays silent.
  return !args.isViewingThisFlow || !args.isWindowFocused ? sound : null;
}
