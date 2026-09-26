import { memo, useEffect, useRef, useState } from 'react';
import { useCanvasUrlCache } from '@/hooks/use-canvas-url-cache';
import { FRAME_INTERVAL_MS, WALK_BY_HEIGHT } from './constants';
import { MascotFigure } from './MascotFigure';
import { createSpriteFrames } from './sprite';

/**
 * Fury-mode sprite triggered by the e5d2 effect.
 *
 * Visual: existing sprite tinted red via CSS filter, with smoke puffs rising
 * from above the head. Walks toward the cursor at a constant speed so it never
 * feels jittery. There's no fullscreen blocking overlay (it's pure decoration)
 * and `pointer-events: none` on the wrapper so the user can keep clicking through.
 *
 * Lifecycle: parent controls mount/unmount via two flags:
 *   - mounting it tells the component to walk in / chase the cursor
 *   - flipping `isExiting=true` retargets the sprite to walk off-screen left
 *   - once off-screen the component fires `onExitComplete` so the parent can
 *     finally unmount, giving us a graceful exit instead of a hard cut.
 */
export const MascotChaser = memo(function MascotChaser({
  isExiting = false,
  onExitComplete,
}: {
  isExiting?: boolean;
  onExitComplete?: () => void;
} = {}) {
  const [sprites] = useState(() => createSpriteFrames());
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<{ x: number; y: number }>({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const posRef = useRef<{ x: number; y: number }>({
    x: -160,
    y: window.innerHeight / 2,
  });
  const frameIdxRef = useRef(0);
  const lastFrameRef = useRef(0);
  const toUrl = useCanvasUrlCache();

  // Track the cursor — feeds into the lerp loop below.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Window resize clamp — without this, if the user shrinks the window
  // (or moves to a smaller display) while enraged, the sprite can sit at a
  // y past the new viewport bottom and stay invisible until the cursor
  // re-enters that y range.
  useEffect(() => {
    const onResize = () => {
      const margin = sprites.height + 40;
      posRef.current.x = Math.min(posRef.current.x, window.innerWidth - margin);
      posRef.current.y = Math.min(Math.max(posRef.current.y, -margin), window.innerHeight - margin);
      cursorRef.current.x = Math.min(cursorRef.current.x, window.innerWidth);
      cursorRef.current.y = Math.min(cursorRef.current.y, window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sprites.height]);

  // Pull `isExiting` into a ref so the animation loop sees changes without
  // re-mounting (the loop's effect deliberately doesn't depend on `isExiting`).
  const isExitingRef = useRef(isExiting);
  isExitingRef.current = isExiting;
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;
  const exitFiredRef = useRef(false);

  // Animation loop: constant-speed pursuit (NOT lerp) + advance walk-cycle frames.
  // Lerp made him glue to a stationary cursor and rocket toward a far one. We want
  // a relentless-but-slow chase: same speed regardless of cursor velocity, with a
  // "personal space" buffer so he never sits on top of the cursor.
  //
  // Exit phase: when `isExiting` flips true, the target becomes off-screen-left
  // instead of the cursor. Same constant-speed walk, just toward the exit door.
  useEffect(() => {
    let animId: number;
    let lastTimestamp = 0;
    const followOffsetX = -sprites.width / 2;
    const followOffsetY = -sprites.height - 40; // sit above the cursor so smoke trails up
    /** px per second — slow, deliberate pursuit. ~200px/s ≈ 32px per walk-stride (160ms). */
    const speedPxPerS = 275;
    /** Stop closing in once we're within this many px of the target — avoids cursor jitter / overlap. */
    const stopDistancePx = 60;
    /** Frink is "off-screen" when his right edge is past the left viewport boundary. */
    const exitThresholdX = -sprites.width - 40;

    const animate = (timestamp: number) => {
      // No img when the voxel Frink renders: he animates his own walk.
      const img = imgRef.current;
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        animId = requestAnimationFrame(animate);
        return;
      }

      const dt = lastTimestamp === 0 ? 0 : (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;

      let targetX: number;
      let targetY: number;
      let stopDistance: number;
      if (isExitingRef.current) {
        // Walk back out the way we came in — leftward off-screen at the same
        // y-anchor, no stop buffer (we want him to keep going past the edge).
        targetX = exitThresholdX;
        targetY = posRef.current.y;
        stopDistance = 0;
      } else {
        targetX = cursorRef.current.x + followOffsetX;
        targetY = cursorRef.current.y + followOffsetY;
        stopDistance = stopDistancePx;
        // If user re-enraged us mid-walkoff, clear the latch so we can fire
        // onExitComplete again the next time we exit.
        exitFiredRef.current = false;
      }

      const dx = targetX - posRef.current.x;
      const dy = targetY - posRef.current.y;
      const distance = Math.hypot(dx, dy);

      if (distance > stopDistance && dt > 0) {
        const step = Math.min(speedPxPerS * dt, distance - stopDistance);
        posRef.current.x += (dx / distance) * step;
        posRef.current.y += (dy / distance) * step;
      }

      // If exiting and we've crossed the off-screen threshold, signal the
      // parent so it can unmount us. Latch with a ref so we only fire once.
      if (isExitingRef.current && !exitFiredRef.current && posRef.current.x <= exitThresholdX) {
        exitFiredRef.current = true;
        onExitCompleteRef.current?.();
      }

      // Always cycle walk frames so he looks animated even when standing still.
      if (img && timestamp - lastFrameRef.current > FRAME_INTERVAL_MS) {
        lastFrameRef.current = timestamp;
        frameIdxRef.current = (frameIdxRef.current + 1) % 3;
        img.src = toUrl(sprites.right[frameIdxRef.current]);
      }

      wrapper.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
      animId = requestAnimationFrame(animate);
    };

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [toUrl, sprites]);

  return (
    <div
      className="fixed inset-0 z-9998 pointer-events-none"
      data-testid="ee-e5d2"
      aria-hidden="true"
    >
      <div
        ref={wrapperRef}
        className="absolute top-0 left-0 will-change-transform ee-fury-shake"
        style={{
          width: sprites.width,
          height: sprites.height,
          transform: `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`,
        }}
      >
        {/* Smoke puffs — pure CSS, layered above the sprite. */}
        <div className="ee-fury-puff ee-fury-puff-a" />
        <div className="ee-fury-puff ee-fury-puff-b" />
        <div className="ee-fury-puff ee-fury-puff-c" />
        <div className="ee-fury-tint">
          <MascotFigure
            pose="walk"
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
