import { useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/use-prefers-reduced-motion';
import { hasWebGl } from '@/lib/webgl/has-webgl';
import { BOARD_OUTER, BOARD_WIDTH } from './chalkboard-geometry';
import { type ChalkboardControls, frinkBuildFor, type SummonPhase } from './summon-choreography';
import { useFrinkPose } from './use-chalkboard-proof';
import { useSummonFrameLoop, useWarpRift } from './use-summon-frame-loop';
import { FRINK_BOX } from './voxel-frink-model';

type Point = { x: number; y: number };
type Layout = { home: Point; board: Point & { width: number } };

const FLOOR_GAP = 32;

function computeLayout(homeXRatio: number): Layout {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const home = {
    x: Math.round(w * homeXRatio - FRINK_BOX.width / 2),
    y: h - FLOOR_GAP - FRINK_BOX.height,
  };
  const width = Math.min(BOARD_WIDTH, w - 32);
  const height = (width * BOARD_OUTER.height) / BOARD_OUTER.width;
  // The board's bottom sits at Frink's waist: he stands in front of it and hovers for the top lines.
  return {
    home,
    board: {
      x: Math.max(16, Math.min(home.x + FRINK_BOX.width * 0.35, w - width - 16)),
      y: Math.max(24, home.y + FRINK_BOX.height * 0.5 - height),
      width,
    },
  };
}

type SummonStageInput = {
  phase: SummonPhase;
  /** Called once Frink has finished at the board. */
  onProofDone: () => void;
  /** Where Frink stands, as a fraction of the window width. */
  homeXRatio: number;
};

/** All the state and effects behind the summon scene; the component only renders it. */
export function useSummonStage({
  phase,
  onProofDone,
  homeXRatio,
}: SummonStageInput) {
  const reducedMotion = usePrefersReducedMotion();
  const [webgl] = useState(hasWebGl);
  const [layout] = useState(() => computeLayout(homeXRatio));

  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  const frinkRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<ChalkboardControls>(null);
  const tipRef = useRef<Point | null>(null);
  const followRef = useRef<Point | null>(null);
  const posRef = useRef<Point>({ ...layout.home });
  const present = phase !== 'walk-out' && phase !== 'done';
  const presentRef = useRef(present);
  presentRef.current = present;

  const build = frinkBuildFor(phase, reducedMotion);

  const fxRef = useSummonFrameLoop({
    home: layout.home,
    fxCanvasRef,
    frinkRef,
    shadowRef,
    followRef,
    tipRef,
    posRef,
    presentRef,
  });

  useWarpRift({ phase, reducedMotion, fxRef, posRef });

  const pose = useFrinkPose({ phase, reducedMotion, boardRef, followRef, onDone: onProofDone });

  return {
    layout,
    webgl,
    pose,
    build,
    present,
    refs: { fxCanvasRef, frinkRef, shadowRef, boardRef, tipRef },
  };
}
