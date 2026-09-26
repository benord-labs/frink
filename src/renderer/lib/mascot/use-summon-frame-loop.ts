import { type RefObject, useEffect, useRef } from 'react';
import { glideFrink, type SummonPhase } from './summon-choreography';
import { createSummonFx, type SummonFx } from './summon-fx';
import { FRINK_BOX } from './voxel-frink-model';

type Point = { x: number; y: number };

/** Paints Frink's box and his floor shadow for one frame. */
function placeFrink(
  frink: HTMLDivElement | null,
  shadow: HTMLDivElement | null,
  pos: Point,
  home: Point,
  lift: number,
  present: boolean,
) {
  if (frink) frink.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  if (!shadow) return;
  const shadowX = pos.x + FRINK_BOX.width / 2 - 40;
  const shadowY = home.y + FRINK_BOX.height - 18;
  shadow.style.transform = `translate(${shadowX}px, ${shadowY}px) scale(${Math.max(0.4, 1 - lift / 220)})`;
  shadow.style.opacity = present ? String(Math.max(0.25, 1 - lift / 160)) : '0';
}

type FrameLoopRefs = {
  home: Point;
  fxCanvasRef: RefObject<HTMLCanvasElement | null>;
  frinkRef: RefObject<HTMLDivElement | null>;
  shadowRef: RefObject<HTMLDivElement | null>;
  /** Where the chalk must touch while writing. */
  followRef: RefObject<Point | null>;
  /** The chalk tip relative to Frink's box, written by the 3D scene each frame. */
  tipRef: RefObject<Point | null>;
  posRef: RefObject<Point>;
  /** False once Frink has warped out: no shadow, no hover jets. */
  presentRef: RefObject<boolean>;
};

/**
 * Runs the summon's one frame loop: draws the effects layer and glides Frink so
 * the chalk in his hand touches the board. Returns the effects layer.
 */
export function useSummonFrameLoop({
  home,
  fxCanvasRef,
  frinkRef,
  shadowRef,
  followRef,
  tipRef,
  posRef,
  presentRef,
}: FrameLoopRefs): RefObject<SummonFx | null> {
  const fxRef = useRef<SummonFx | null>(null);
  useEffect(() => {
    const canvas = fxCanvasRef.current;
    if (!canvas) return;
    const fx = createSummonFx({ canvas, ctx: canvas.getContext('2d') });
    // Soft dust needs no retina detail; capping the ratio keeps a full-window canvas cheap.
    fx.resize(window.innerWidth, window.innerHeight, Math.min(1.5, window.devicePixelRatio || 1));
    fxRef.current = fx;
    let last = performance.now();
    let raf = 0;
    let painted: boolean | null = null;
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      fx.frame(now, dt);
      const { pos, lift } = glideFrink({
        pos: posRef.current,
        home: home,
        follow: followRef.current,
        tip: tipRef.current,
        dt,
      });
      const prev = posRef.current;
      posRef.current = pos;
      // Paint only when something changed: at rest Frink and his shadow are left alone.
      const moved = Math.abs(pos.x - prev.x) + Math.abs(pos.y - prev.y) > 0.05;
      if (moved || presentRef.current !== painted) {
        painted = presentRef.current;
        placeFrink(frinkRef.current, shadowRef.current, pos, home, lift, painted);
      }
      if (presentRef.current && lift > 8 && Math.random() < 0.7) {
        fx.hoverJet({ x: pos.x + FRINK_BOX.width / 2, y: pos.y + FRINK_BOX.height * 0.94 });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      fx.clear();
      fxRef.current = null;
    };
  }, [home, fxCanvasRef, frinkRef, shadowRef, followRef, tipRef, posRef, presentRef]);
  return fxRef;
}

type WarpRiftDeps = {
  phase: SummonPhase;
  reducedMotion: boolean;
  fxRef: RefObject<SummonFx | null>;
  posRef: RefObject<Point>;
};

/** Opens the time rift Frink warps in and out through. */
export function useWarpRift({ phase, reducedMotion, fxRef, posRef }: WarpRiftDeps) {
  useEffect(() => {
    const warping = phase === 'walk-in' || phase === 'walk-out';
    if (reducedMotion || !warping) return;
    const { x, y } = posRef.current;
    const center = { x: x + FRINK_BOX.width / 2, y: y + FRINK_BOX.height * 0.55 };
    fxRef.current?.rift(center, 190, phase === 'walk-in' ? 1700 : 1300);
  }, [phase, reducedMotion, fxRef, posRef]);
}
