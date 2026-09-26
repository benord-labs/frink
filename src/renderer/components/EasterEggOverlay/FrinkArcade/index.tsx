import { useCallback, useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { BOSS_STAGE } from '@/lib/mascot/bug-invaders';
import { type ArcadeHud, useBugInvaders } from '@/lib/mascot/use-bug-invaders';
import { createSpriteFrames } from '../../Mascot';

const STAGE_TAGLINES = [
  'Clear the backlog',
  'Merge conflicts incoming',
  'Flaky tests detected',
  'Production is on fire',
];

/** The pixel Frink standing, as the boss. */
function bossSprite(): CanvasImageSource {
  return createSpriteFrames().right[1];
}

function bannerFor(hud: ArcadeHud): [string, string] | null {
  if (hud.status === 'gameOver') return ['Game over', 'Space to retry · Esc to quit'];
  if (hud.status === 'won') return ['You win', '30 lives well spent · Space to play again'];
  if (hud.status !== 'banner') return null;
  if (hud.stage === BOSS_STAGE) return ['Boss', 'Prof. Frink'];
  return [`Stage ${hud.stage}`, STAGE_TAGLINES[hud.stage - 1] ?? ''];
}

function announcementFor(hud: ArcadeHud): string {
  if (hud.status === 'gameOver') return `Game over. Score ${hud.score}.`;
  if (hud.status === 'won') return `You win. Score ${hud.score}.`;
  return '';
}

type FrinkArcadeProps = {
  run: number;
  onDone: (run: number) => void;
};

/** Konami: Bug Invaders, played over the dimmed app in a CRT cabinet. Escape quits. */
export function FrinkArcade({ run, onDone }: FrinkArcadeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const quit = useCallback(() => onDone(run), [onDone, run]);
  const hud = useBugInvaders({
    canvasRef,
    makeBossSprite: bossSprite,
    reducedMotion,
    onQuit: quit,
  });

  // The game takes focus from whatever had it (say, the composer) and hands it back on exit.
  useEffect(() => {
    const previous = document.activeElement;
    if (previous instanceof HTMLElement) previous.blur();
    rootRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const banner = bannerFor(hud);
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Bug Invaders. Press Escape to quit."
      // Marks an open dialog layer, so the app's Escape handlers stand down while the game runs.
      data-state="open"
      data-testid="frink-arcade"
      className="ee-arcade fixed inset-0 z-9999 outline-none"
    >
      <div className="ee-arcade-glass absolute inset-0" />
      <div className="ee-arcade-scanlines absolute inset-0" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div className="ee-arcade-bezel pointer-events-none absolute inset-0" />
      <div className="ee-arcade-glow absolute inset-x-0 top-0 flex justify-between bg-black/70 px-12 py-5 font-arcade text-xs uppercase">
        <span>1UP {String(hud.score).padStart(6, '0')}</span>
        <span>HI {String(hud.hiScore).padStart(6, '0')}</span>
        <span>Lives ×{hud.lives}</span>
      </div>
      {banner && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p className="ee-arcade-glow font-arcade text-5xl uppercase">{banner[0]}</p>
          <p className="ee-arcade-blink font-arcade text-xs uppercase">{banner[1]}</p>
        </div>
      )}
      <p className="ee-arcade-glow absolute inset-x-0 bottom-6 text-center font-arcade text-[10px] uppercase opacity-70">
        ← → move · Space fire · Esc quit
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcementFor(hud)}
      </p>
    </div>
  );
}
