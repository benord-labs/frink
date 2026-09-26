import { useAtomValue } from 'jotai';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { selectedProjectAtom } from '@/features/agents/atoms';
import type { BoardStats } from '@/lib/mascot/chalkboard-geometry';
import type { SummonPhase } from '@/lib/mascot/summon-choreography';
import {
  BUBBLE_SHOW_MS,
  EXIT_COMPLETE_DELAY_MS,
  MAX_SUMMONING_MS,
  POKE_LAST_STRAW,
  POKE_QUIP_MS,
  POKE_QUIPS,
  POKES_TO_LEAVE,
  REACTION_QUIPS,
  REACTION_SHOW_MS,
  SPEECH_QUIPS,
  WALKOUT_DELAY_MS,
  WARP_IN_MS,
  WARP_OUT_MS,
} from './constants';
import { SummonScene } from './SummonScene';

export { createSpriteFrames } from './sprite';

function pick(quips: readonly string[]): string {
  return quips[Math.floor(Math.random() * quips.length)] ?? '';
}

/** The project's recent diffstat for the chalkboard; null when git has nothing to say. */
async function fetchBoardStats(projectPath: string): Promise<BoardStats | null> {
  try {
    // Loaded on use, so importing the Mascot never needs the Electron IPC bridge.
    const { trpcClient } = await import('@/lib/trpc');
    return await trpcClient.changes.getRecentCommitStats.query({ projectPath });
  } catch {
    return null;
  }
}

function isLeaving(phase: SummonPhase): boolean {
  return phase === 'walk-out' || phase === 'done';
}

function fromBoardToReaction(phase: SummonPhase): SummonPhase {
  return phase === 'summoning' ? 'reacting' : phase;
}

/** HELPFRINK: Frink warps in, works a proof on his chalkboard, reacts, and warps out.
 * Escape or a click anywhere sends him off early; poking him three times does too. */
type MascotWalkOnProps = {
  onComplete: () => void;
  fetchStats?: (projectPath: string) => Promise<BoardStats | null>;
};

export const MascotWalkOn = memo(function MascotWalkOn({
  onComplete,
  fetchStats = fetchBoardStats,
}: MascotWalkOnProps) {
  const phaseRef = useRef<SummonPhase>('walk-in');
  const quipRef = useRef(pick(SPEECH_QUIPS));
  const [phase, setPhase] = useState<SummonPhase>('walk-in');
  const [bubbleText, setBubbleText] = useState('');
  const [showBubble, setShowBubble] = useState(false);
  const [bubbleSwap, setBubbleSwap] = useState(false);
  const [pokes, setPokes] = useState(0);
  /** A poke's quip, shown over the phase bubble; the last straw stays up while he leaves. */
  const [pokeQuip, setPokeQuip] = useState<string | null>(null);
  const projectPath = useAtomValue(selectedProjectAtom)?.path ?? null;
  /** Stats that arrive after Frink turns to the board are dropped: he is already writing. */
  const fetchedStatsRef = useRef<BoardStats | null>(null);
  const [boardStats, setBoardStats] = useState<BoardStats | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Updaters read the committed phase, so a proof finishing in the same tick as a
  // dismissal can never pull Frink back from walking out.
  const leave = useCallback(() => setPhase((p) => (isLeaving(p) ? p : 'walk-out')), []);
  const onProofDone = useCallback(() => setPhase(fromBoardToReaction), []);
  const onPoke = useCallback(() => {
    const p = phaseRef.current;
    if (p !== 'walk-in' && !isLeaving(p)) setPokes((n) => n + 1);
  }, []);

  useEffect(() => {
    if (pokes === 0) return;
    if (pokes >= POKES_TO_LEAVE) {
      setPokeQuip(POKE_LAST_STRAW);
      leave();
      return;
    }
    setPokeQuip(pick(POKE_QUIPS));
    const timer = setTimeout(() => setPokeQuip(null), POKE_QUIP_MS);
    return () => clearTimeout(timer);
  }, [pokes, leave]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isLeaving(phaseRef.current)) return;
      e.preventDefault();
      leave();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [leave]);

  useEffect(() => {
    fetchedStatsRef.current = null;
    setBoardStats(null);
    if (!projectPath) return;
    let live = true;
    void fetchStats(projectPath).then((stats) => {
      if (live) fetchedStatsRef.current = stats;
    });
    return () => {
      live = false;
    };
  }, [projectPath, fetchStats]);

  // Phase: walk-in — Frink assembles out of the time rift.
  useEffect(() => {
    if (phase !== 'walk-in') return;
    const timer = setTimeout(() => setPhase('speak'), WARP_IN_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase: speak — an opening quip before he turns to the board.
  useEffect(() => {
    if (phase !== 'speak') return;
    setBubbleText(quipRef.current);
    setShowBubble(true);
    const timer = setTimeout(() => setPhase('summoning'), BUBBLE_SHOW_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase: summoning — the chalkboard proof; onProofDone moves on, the backstop caps it.
  useEffect(() => {
    if (phase !== 'summoning') return;
    setShowBubble(false);
    setBoardStats(fetchedStatsRef.current);
    const timer = setTimeout(() => setPhase(fromBoardToReaction), MAX_SUMMONING_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Phase: reacting — a reaction quip, then walk out.
  useEffect(() => {
    if (phase !== 'reacting') return;
    setBubbleSwap(true);
    const swapTimer = setTimeout(() => {
      setBubbleText(pick(REACTION_QUIPS));
      setShowBubble(true);
      setBubbleSwap(false);
    }, 200);
    const hideTimer = setTimeout(() => setShowBubble(false), REACTION_SHOW_MS);
    const walkTimer = setTimeout(() => setPhase('walk-out'), REACTION_SHOW_MS + WALKOUT_DELAY_MS);
    return () => {
      clearTimeout(swapTimer);
      clearTimeout(hideTimer);
      clearTimeout(walkTimer);
    };
  }, [phase]);

  // Phase: walk-out — Frink bursts back into the rift.
  useEffect(() => {
    if (phase !== 'walk-out') return;
    setShowBubble(false);
    const timer = setTimeout(() => setPhase('done'), WARP_OUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(onComplete, EXIT_COMPLETE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  return (
    <>
      {phase !== 'done' && (
        <button
          type="button"
          aria-label="Dismiss Professor Frink"
          className="fixed inset-0 z-9997 cursor-default ee-curtain"
          onClick={leave}
        />
      )}
      <div className="fixed inset-0 z-9998 pointer-events-none ee-sprite-enter">
        <SummonScene
          phase={phase}
          pokes={pokes}
          onPoke={onPoke}
          onProofDone={onProofDone}
          boardStats={boardStats}
        >
          {(pokeQuip !== null || showBubble) && (
            <div
              className={`ee-tip absolute bottom-full left-1/2 -translate-x-1/2 mb-3 ${bubbleSwap ? 'ee-tip-swap' : ''}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <p className="font-mono text-xs leading-relaxed whitespace-nowrap">
                {pokeQuip ?? bubbleText}
              </p>
            </div>
          )}
        </SummonScene>
      </div>
    </>
  );
});
