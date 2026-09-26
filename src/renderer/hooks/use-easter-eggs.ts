/**
 * Easter eggs — atoms, trigger sequences and the Konami escalation engine.
 * Triggers are matched in the renderer and flip these atoms; `EasterEggOverlay` renders them.
 */

import { atom, useSetAtom } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';

/** The Bug Invaders run on screen, by id; null when no game is open. */
export const arcadeRunAtom = atom<number | null>(null);

/** DVD-style bouncing logo, from long-pressing the sidebar wordmark. */
export const floatingBadgeActiveAtom = atom(false);

/** Pixel Frink walks across the screen, from typing HELPFRINK. */
export const mascotWalkOnActiveAtom = atom(false);

/** Silent Pixel Frink cameo, from clicking the logo exactly 15 times. */
export const mascotCameoActiveAtom = atom(false);

/** Enraged Pixel Frink chasing the cursor, from clicking the logo 30+ times. */
export const mascotChaserActiveAtom = atom(false);

export const KONAMI_SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA',
] as const;

export const HELP_FRINK_SEQUENCE = [
  'KeyH',
  'KeyE',
  'KeyL',
  'KeyP',
  'KeyF',
  'KeyR',
  'KeyI',
  'KeyN',
  'KeyK',
] as const;

/** Module-wide so a remounted hook never reuses a run id. */
let arcadeRunSeq = 0;

/** Starts a fresh Bug Invaders game. */
export function useStartArcade() {
  const setRun = useSetAtom(arcadeRunAtom);
  return useCallback(() => {
    arcadeRunSeq += 1;
    setRun(arcadeRunSeq);
  }, [setRun]);
}

export const LATE_NIGHT_LINE = 'Sleep is for the weak... and the well-rested.';
const LATE_NIGHT_KEY = 'frink:late-night-cameo';
/** Set once shown, for when localStorage can't hold it. */
let lateNightShownInMemory = false;

function lateNightAlreadyShown(): boolean {
  // Memory first: storage that reads but can't write (quota) would otherwise never remember.
  if (lateNightShownInMemory) return true;
  try {
    return localStorage.getItem(LATE_NIGHT_KEY) !== null;
  } catch {
    return false;
  }
}

function markLateNightShown() {
  lateNightShownInMemory = true;
  try {
    localStorage.setItem(LATE_NIGHT_KEY, 'shown');
  } catch {
    // The in-memory mark still holds for this session.
  }
}

/**
 * Calls `show` the first time Frink is opened or focused between 03:00 and 03:59, then never
 * again. `show` returns false when it could not show now, so the surprise stays unclaimed.
 */
export function useLateNightCameo(show: () => boolean) {
  useEffect(() => {
    const check = () => {
      if (new Date().getHours() !== 3 || lateNightAlreadyShown()) return;
      if (show()) markLateNightShown();
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [show]);
}

/** True when a text-entry surface owns focus, so typed sequences are ignored. */
export function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return Boolean(
    el.closest(
      '[contenteditable="true"], [role="textbox"], [role="combobox"], .cm-editor, .ProseMirror',
    ),
  );
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

type KeySequenceOptions = {
  /** Gap between keys that clears the partial match. */
  timeoutMs?: number;
  shouldIgnore?: (e: KeyboardEvent) => boolean;
};

/**
 * Fires `onMatch` when the last N `KeyboardEvent.code`s equal `sequence`.
 * Pass a stable `onMatch` — the listener re-registers when it changes.
 */
export function useKeySequence(
  sequence: readonly string[],
  onMatch: () => void,
  { timeoutMs = 2000, shouldIgnore }: KeySequenceOptions = {},
) {
  const bufferRef = useRef<string[]>([]);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (shouldIgnore?.(e)) {
        bufferRef.current = [];
        return;
      }

      bufferRef.current.push(e.code);
      if (bufferRef.current.length > sequence.length) bufferRef.current.shift();

      if (
        bufferRef.current.length === sequence.length &&
        bufferRef.current.every((code, i) => code === sequence[i])
      ) {
        bufferRef.current = [];
        onMatch();
        return;
      }

      timeoutRef.current = setTimeout(() => {
        bufferRef.current = [];
      }, timeoutMs);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [sequence, onMatch, timeoutMs, shouldIgnore]);
}
