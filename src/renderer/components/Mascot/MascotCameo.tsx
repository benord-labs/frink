import { memo, useEffect, useRef, useState } from 'react';
import { useCanvasUrlCache } from '@/hooks/use-canvas-url-cache';
import type { FrinkPose } from '@/lib/mascot/voxel-frink-model';
import {
  CAMEO_LINE_PAUSE_MS,
  CAMEO_PAUSE_MS,
  EXIT_COMPLETE_DELAY_MS,
  FRAME_INTERVAL_MS,
  PAUSE_X_RATIO,
  WALK_BY_HEIGHT,
  WALK_SPEED,
} from './constants';
import { MascotFigure } from './MascotFigure';
import { createSpriteFrames } from './sprite';

type Phase = 'walk-in' | 'pause' | 'walk-out' | 'done';

/** Frink stands still for the pause and walks otherwise. */
function cameoPose(phase: Phase): FrinkPose {
  return phase === 'pause' ? 'stand' : 'walk';
}

/**
 * Lightweight sprite cameo triggered by the c8b4 effect.
 *
 * Walks in from the sidebar edge, pauses by the logo with a single `...` bubble,
 * walks off. Reuses the sprite + walk animation infra but intentionally
 * skips:
 *   - the fullscreen blocking overlay (this should never trap the user)
 *   - chat creation / project resolution / streaming subscription
 *   - the quip carousel / speak / reacting / summoning state machine
 *
 * The cameo is purely visual feedback. The full sprite experience
 * ({@link MascotWalkOn}) handles chat creation and summoning.
 */
type MascotCameoProps = {
  onComplete: () => void;
  /** What Frink says at the pause; a silent '...' when omitted. */
  line?: string;
};

const SILENT = '...';

/** A spoken line holds long enough to read; the silent cameo just pauses. */
function pauseFor(line: string): number {
  return line === SILENT ? CAMEO_PAUSE_MS : CAMEO_LINE_PAUSE_MS;
}

export const MascotCameo = memo(function MascotCameo({
  onComplete,
  line = SILENT,
}: MascotCameoProps) {
  const [sprites] = useState(() => createSpriteFrames());
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<Phase>('walk-in');
  const posRef = useRef(-80);
  const frameIdxRef = useRef(0);
  const lastFrameRef = useRef(0);
  const toUrl = useCanvasUrlCache();

  const [phase, setPhase] = useState<Phase>('walk-in');
  const [showBubble, setShowBubble] = useState(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Pause phase — show silent '...' bubble, then walk off.
  useEffect(() => {
    if (phase !== 'pause') return;
    setShowBubble(true);
    const walkTimer = setTimeout(() => {
      setShowBubble(false);
      setPhase('walk-out');
    }, pauseFor(line));
    return () => clearTimeout(walkTimer);
  }, [phase, line]);

  // Done phase — trigger onComplete after exit animation settles.
  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(onComplete, EXIT_COMPLETE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);

  // Walk animation loop.
  useEffect(() => {
    const pauseX = window.innerWidth * PAUSE_X_RATIO;
    let animId: number;

    const animate = (timestamp: number) => {
      // No img when the voxel Frink renders: he animates his own walk.
      const img = imgRef.current;
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        animId = requestAnimationFrame(animate);
        return;
      }

      const p = phaseRef.current;
      if (p === 'done') return;

      if (img && timestamp - lastFrameRef.current > FRAME_INTERVAL_MS) {
        lastFrameRef.current = timestamp;
        if (p === 'walk-in' || p === 'walk-out') {
          frameIdxRef.current = (frameIdxRef.current + 1) % 3;
        } else {
          frameIdxRef.current = 1; // stand frame during pause
        }
        img.src = toUrl(sprites.right[frameIdxRef.current]);
      }

      if (p === 'walk-in') {
        posRef.current += WALK_SPEED;
        if (posRef.current >= pauseX) {
          posRef.current = pauseX;
          setPhase('pause');
        }
      } else if (p === 'walk-out') {
        posRef.current += WALK_SPEED;
        if (posRef.current > window.innerWidth + 120) {
          setPhase('done');
          return;
        }
      }

      wrapper.style.transform = `translateX(${posRef.current}px)`;
      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [toUrl, sprites]);

  // Note: NO fullscreen overlay. The cameo is purely cosmetic and must never
  // capture pointer events from the rest of the app.
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-9998 pointer-events-none ee-sprite-enter"
      data-testid="ee-c8b4"
    >
      <div
        ref={wrapperRef}
        className="absolute bottom-8 will-change-transform"
        style={{ transform: `translateX(${posRef.current}px)` }}
      >
        <div className="relative">
          {showBubble && (
            <div
              className="ee-tip absolute bottom-full left-1/2 -translate-x-1/2 mb-3"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <p className="font-mono text-xs leading-relaxed whitespace-nowrap">{line}</p>
            </div>
          )}
          <MascotFigure
            pose={cameoPose(phase)}
            height={WALK_BY_HEIGHT}
            sprite={
              <img
                ref={imgRef}
                alt=""
                draggable={false}
                style={{
                  width: sprites.width,
                  height: sprites.height,
                  imageRendering: 'pixelated',
                }}
                className="pointer-events-none select-none"
              />
            }
          />
        </div>
      </div>
    </div>
  );
});
