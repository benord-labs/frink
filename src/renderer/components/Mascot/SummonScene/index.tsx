import * as Sentry from '@sentry/electron/renderer';
import {
  Component,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useCanvasUrlCache } from '@/hooks/use-canvas-url-cache';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { type BoardStats, boardLines } from '@/lib/mascot/chalkboard-geometry';
import type { SummonPhase } from '@/lib/mascot/summon-choreography';
import { useSummonStage } from '@/lib/mascot/use-summon-stage';
import {
  FRINK_BOX,
  FRINK_CANVAS,
  type FrinkBuild,
  type FrinkPose,
} from '@/lib/mascot/voxel-frink-model';
import { Chalkboard } from '../Chalkboard';
import { PAUSE_X_RATIO } from '../constants';
import { createSpriteFrames } from '../sprite';

const FLINCH_FRAMES: Keyframe[] = [
  { transform: 'scale(1, 1)' },
  { transform: 'scale(1.12, 0.84)' },
  { transform: 'scale(0.95, 1.06)' },
  { transform: 'scale(1, 1)' },
];

/** Soft contact shadow under Frink; part of the illustration, like his voxel colours. */
const FLOOR_SHADOW = 'radial-gradient(#000c, #0000 70%)';

/** three.js stays out of the main chunk until a WebGL-capable summon needs it. */
export const VoxelFrink = lazy(() =>
  import('../VoxelFrink').then((m) => ({ default: m.VoxelFrink })),
);

type Point = { x: number; y: number };

function SpriteFallback() {
  const [sprites] = useState(createSpriteFrames);
  const toUrl = useCanvasUrlCache();
  return (
    <img
      alt=""
      draggable={false}
      src={toUrl(sprites.right[1])}
      className="absolute bottom-0 left-1/2 -translate-x-1/2 select-none"
      style={{ width: sprites.width, height: sprites.height, imageRendering: 'pixelated' }}
    />
  );
}

type FallbackBoundaryProps = { children: ReactNode; fallback: ReactNode };

/** A failed three.js chunk or WebGL context drops Frink to the pixel sprite instead of ending the summon. */
export class VoxelFallbackBoundary extends Component<FallbackBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    Sentry.captureException(error, { tags: { source: 'SummonScene', area: 'voxel-frink' } });
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type FrinkBodyProps = {
  webgl: boolean;
  /** False once Frink has warped out. */
  present: boolean;
  pose: FrinkPose;
  build: FrinkBuild;
  tipRef: RefObject<Point | null>;
};

/** The voxel Frink when WebGL is available, else the pixel sprite. */
function FrinkBody({ webgl, present, pose, build, tipRef }: FrinkBodyProps) {
  const canvasOffset = {
    left: (FRINK_BOX.width - FRINK_CANVAS.width) / 2,
    top: (FRINK_BOX.height - FRINK_CANVAS.height) / 2,
  };
  return (
    <>
      <div data-mascot-body className="absolute" style={webgl ? canvasOffset : { inset: 0 }}>
        {webgl && (
          <VoxelFallbackBoundary
            fallback={
              <div
                className="absolute"
                style={{
                  left: -canvasOffset.left,
                  top: -canvasOffset.top,
                  width: FRINK_BOX.width,
                  height: FRINK_BOX.height,
                }}
              >
                {present && <SpriteFallback />}
              </div>
            }
          >
            <Suspense fallback={null}>
              <VoxelFrink pose={pose} build={build} tipRef={tipRef} />
            </Suspense>
          </VoxelFallbackBoundary>
        )}
        {!webgl && present && <SpriteFallback />}
      </div>
    </>
  );
}

type SummonSceneProps = {
  phase: SummonPhase;
  /** Times Frink has been poked; each new poke makes him flinch. */
  pokes: number;
  onPoke: () => void;
  /** Called once Frink has finished at the board. */
  onProofDone: () => void;
  /** The project's recent diffstat for the board, or null for the generic maths. */
  boardStats: BoardStats | null;
  /** The speech bubble; rides along above Frink's head. */
  children: ReactNode;
};

/** Everything visual in a HELPFRINK summon: voxel Frink, chalkboard and effects.
 * MascotWalkOn owns the phases and timing; this only reacts to them. */
export function SummonScene({
  phase,
  pokes,
  onPoke,
  onProofDone,
  boardStats,
  children,
}: SummonSceneProps) {
  const lines = useMemo(() => boardLines(boardStats), [boardStats]);
  const { layout, webgl, pose, build, present, refs } = useSummonStage({
    phase,
    onProofDone,
    homeXRatio: PAUSE_X_RATIO,
  });
  const reducedMotion = usePrefersReducedMotion();
  const bodyRef = useRef<HTMLDivElement>(null);

  // The flinch squashes the inner body: the frame loop owns the outer box's transform.
  useEffect(() => {
    if (pokes === 0 || reducedMotion) return;
    bodyRef.current?.animate?.(FLINCH_FRAMES, { duration: 320, easing: 'ease-out' });
  }, [pokes, reducedMotion]);

  return (
    <>
      <Chalkboard
        ref={refs.boardRef}
        lines={lines}
        style={{ left: layout.board.x, top: layout.board.y, width: layout.board.width }}
      />
      <canvas ref={refs.fxCanvasRef} className="absolute inset-0 h-full w-full" />
      <div
        ref={refs.shadowRef}
        className="absolute top-0 left-0 h-3.5 w-20 rounded-full opacity-0 transition-opacity duration-300"
        style={{ background: FLOOR_SHADOW }}
      />
      <div
        ref={refs.frinkRef}
        className="absolute top-0 left-0"
        style={{
          width: FRINK_BOX.width,
          height: FRINK_BOX.height,
          transform: `translate(${layout.home.x}px, ${layout.home.y}px)`,
        }}
      >
        <div ref={bodyRef} className="absolute inset-0 origin-bottom">
          <FrinkBody
            webgl={webgl}
            present={present}
            pose={pose}
            build={build}
            tipRef={refs.tipRef}
          />
        </div>
        <button
          type="button"
          aria-label="Poke Professor Frink"
          className="pointer-events-auto absolute inset-0 cursor-pointer"
          onClick={onPoke}
        />
        {children}
      </div>
    </>
  );
}
