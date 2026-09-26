import { type RefObject, useEffect, useRef, useState } from 'react';
import {
  type ChalkboardControls,
  poseForPhase,
  runChalkboardProof,
  type SummonPhase,
} from './summon-choreography';
import type { CancelToken } from './timeline';
import type { FrinkPose } from './voxel-frink-model';

type Point = { x: number; y: number };

type ChalkboardProofDeps = {
  /** True while Frink is at the board. */
  active: boolean;
  reducedMotion: boolean;
  boardRef: RefObject<ChalkboardControls | null>;
  setPose: (pose: FrinkPose) => void;
  followRef: RefObject<Point | null>;
  /** Called once the board has rolled up after a finished proof. */
  onDone: () => void;
};

/** Plays Frink's chalkboard proof while active; fades the board if the summon ends first. */
export function useChalkboardProof({
  active,
  reducedMotion,
  boardRef,
  setPose,
  followRef,
  onDone,
}: ChalkboardProofDeps) {
  const shownRef = useRef(false);
  const solvedRef = useRef(false);

  useEffect(() => {
    const board = boardRef.current;
    if (!active || !board) return;
    const token: CancelToken = { cancelled: false };
    shownRef.current = true;
    solvedRef.current = false;
    runChalkboardProof({
      board,
      token,
      reducedMotion,
      setPose,
      follow: (at) => {
        followRef.current = at;
      },
    }).then((finished) => {
      // A cancelled run settles late; only the live run may record the outcome.
      if (token.cancelled) return;
      solvedRef.current = finished;
      if (finished) onDone();
    });
    return () => {
      token.cancelled = true;
      followRef.current = null;
    };
  }, [active, reducedMotion, boardRef, setPose, followRef, onDone]);

  // Fade from here, not from the cleanup: a Strict Mode re-run cleans up and then
  // unrolls the same board again, and must not race a fade-out.
  useEffect(() => {
    if (active || !shownRef.current || solvedRef.current) return;
    boardRef.current?.fadeOut();
  }, [active, boardRef]);
}

type FrinkPoseInput = Omit<ChalkboardProofDeps, 'active' | 'setPose'> & { phase: SummonPhase };

/** Frink's pose through a summon: the chalkboard routine drives it, phase changes settle it. */
export function useFrinkPose({ phase, ...proof }: FrinkPoseInput): FrinkPose {
  const [pose, setPose] = useState<FrinkPose>('stand');

  useEffect(() => {
    const next = poseForPhase(phase);
    if (next) setPose(next);
  }, [phase]);

  useChalkboardProof({ ...proof, active: phase === 'summoning', setPose });
  return pose;
}
