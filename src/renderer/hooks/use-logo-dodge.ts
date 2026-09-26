/**
 * Logo dodge — the sidebar logo gets "alive" the more you click it (see the *_AT_CLICKS
 * milestones below); the click count resets after 15 s without a click.
 */

import { useSetAtom } from 'jotai';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { mascotCameoActiveAtom, mascotChaserActiveAtom } from './use-easter-eggs';

type DodgePhase = 'idle' | 'active';

type UseLogoDodgeReturn = {
  offset: { x: number; y: number };
  phase: DodgePhase;
  handlePointerDown(): void;
};

const DECAY_MS = 15 * 1000;
const DRIFT_BACK_MS = 10000;
const DODGE_VIEWPORT_PADDING_PX = 16;
const DODGE_MIN_DISTANCE_PX = 120;

const DODGE_AFTER_CLICKS = 3;
const CAMEO_AT_CLICKS = 15;
const ENRAGED_AT_CLICKS = 30;

function dodgeOffset(home: DOMRect | null): { x: number; y: number } {
  if (!home) {
    const magnitude = 120 + Math.random() * 280;
    const angle = Math.random() * Math.PI * 2;
    return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude * 0.5 };
  }

  const w = home.width || 80;
  const h = home.height || 28;
  const minX = DODGE_VIEWPORT_PADDING_PX;
  const maxX = Math.max(minX + 1, window.innerWidth - w - DODGE_VIEWPORT_PADDING_PX);
  const minY = DODGE_VIEWPORT_PADDING_PX;
  const maxY = Math.max(minY + 1, window.innerHeight - h - DODGE_VIEWPORT_PADDING_PX);

  for (let attempt = 0; attempt < 5; attempt++) {
    const targetX = minX + Math.random() * (maxX - minX);
    const targetY = minY + Math.random() * (maxY - minY);
    const dx = targetX - home.left;
    const dy = targetY - home.top;
    if (Math.hypot(dx, dy) >= DODGE_MIN_DISTANCE_PX) {
      return { x: dx, y: dy };
    }
  }
  const targetX = minX + Math.random() * (maxX - minX);
  const targetY = minY + Math.random() * (maxY - minY);
  return { x: targetX - home.left, y: targetY - home.top };
}

export function useLogoDodge(targetRef: RefObject<HTMLElement | null>): UseLogoDodgeReturn {
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [phase, setPhase] = useState<DodgePhase>('idle');
  const setCameoActive = useSetAtom(mascotCameoActiveAtom);
  const setChaserActive = useSetAtom(mascotChaserActiveAtom);

  const countRef = useRef(0);
  const driftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goHome = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    if (driftTimerRef.current) {
      clearTimeout(driftTimerRef.current);
      driftTimerRef.current = null;
    }
  }, []);

  const scheduleDriftBack = useCallback(() => {
    if (driftTimerRef.current) clearTimeout(driftTimerRef.current);
    driftTimerRef.current = setTimeout(goHome, DRIFT_BACK_MS);
  }, [goHome]);

  const scheduleDecay = useCallback(() => {
    if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    decayTimerRef.current = setTimeout(() => {
      countRef.current = 0;
      setPhase('idle');
      setChaserActive(false);
      goHome();
      decayTimerRef.current = null;
    }, DECAY_MS);
  }, [goHome, setChaserActive]);

  const handlePointerDown = useCallback(() => {
    countRef.current += 1;
    const clickCount = countRef.current;

    if (clickCount === CAMEO_AT_CLICKS) setCameoActive(true);

    if (clickCount >= ENRAGED_AT_CLICKS) {
      // The chaser has the stage; the logo itself goes back to rest.
      setChaserActive(true);
      goHome();
    } else if (clickCount >= DODGE_AFTER_CLICKS) {
      setPhase('active');
      setOffset(dodgeOffset(targetRef.current?.getBoundingClientRect() ?? null));
      scheduleDriftBack();
    }

    scheduleDecay();
  }, [goHome, scheduleDriftBack, scheduleDecay, setCameoActive, setChaserActive, targetRef]);

  // Unmounting drops the decay timer, so release the chaser here or it never leaves.
  useEffect(() => {
    return () => {
      if (driftTimerRef.current) clearTimeout(driftTimerRef.current);
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
      setChaserActive(false);
    };
  }, [setChaserActive]);

  return { offset, phase, handlePointerDown };
}
