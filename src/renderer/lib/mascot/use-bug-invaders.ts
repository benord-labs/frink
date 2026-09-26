import { type RefObject, useEffect, useRef, useState } from 'react';
import { createGame, type GameInput, type GameState, type GameStatus, step } from './bug-invaders';
import { drawGame } from './bug-invaders-draw';

export type ArcadeHud = {
  status: GameStatus;
  stage: number;
  score: number;
  lives: number;
  hiScore: number;
};

type BugInvadersOptions = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** The boss's pixel art; called once the canvas has a 2D context. */
  makeBossSprite: () => CanvasImageSource;
  reducedMotion: boolean;
  onQuit: () => void;
};

const HI_SCORE_KEY = 'frink:bug-invaders-hi';
/** A game-over screen ignores Space this long, so a held fire key never skips it. */
const RESTART_GRACE_MS = 500;
const MAX_DT = 1 / 30;

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const FIRE = new Set(['Space', 'ArrowUp', 'KeyW']);

/** A stored hi-score, or 0 when it is missing or not a sane score. */
export function parseHiScore(raw: string | null): number {
  const score = Number(raw);
  return Number.isSafeInteger(score) && score > 0 ? score : 0;
}

function readHiScore(): number {
  try {
    return parseHiScore(localStorage.getItem(HI_SCORE_KEY));
  } catch {
    return 0;
  }
}

function writeBest(score: number): number {
  const best = Math.max(score, readHiScore());
  try {
    localStorage.setItem(HI_SCORE_KEY, String(best));
  } catch {
    // The hi-score only lasts this session then.
  }
  return best;
}

/** Saves `score` if it beats the stored best. A Web Lock makes the read-compare-write
 * atomic across windows, so a lower score never overwrites a higher one. */
export function saveHiScore(score: number): Promise<number> {
  return navigator.locks.request(HI_SCORE_KEY, () => writeBest(score));
}

function inputFrom(held: Set<string>): GameInput {
  const has = (keys: Set<string>) => [...keys].some((k) => held.has(k));
  return { left: has(LEFT), right: has(RIGHT), fire: has(FIRE) };
}

function hudOf(s: GameState, hiScore: number): ArcadeHud {
  return { status: s.status, stage: s.stage, score: s.score, lives: s.lives, hiScore };
}

function sameHud(a: ArcadeHud, b: ArcadeHud): boolean {
  return (
    a.status === b.status &&
    a.stage === b.stage &&
    a.score === b.score &&
    a.lives === b.lives &&
    a.hiScore === b.hiScore
  );
}

/** Sizes the canvas backing store to the window at device resolution. */
function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

type Session = {
  game: GameState;
  held: Set<string>;
  hiScore: number;
  /** When the last game ended, so a held Space can't skip the game-over screen. */
  endedAt: number;
  paused: boolean;
};

function isOver(game: GameState): boolean {
  return game.status === 'gameOver' || game.status === 'won';
}

/** Keyboard owner: every non-shortcut key is swallowed so none reaches the app. */
function onKeyDown(session: Session, e: KeyboardEvent, quit: () => void) {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    quit();
    return;
  }
  const canRestart = performance.now() - session.endedAt > RESTART_GRACE_MS;
  if (isOver(session.game) && e.code === 'Space' && !e.repeat && canRestart) {
    session.game = createGame();
    return;
  }
  session.held.add(e.code);
}

/** Advances and draws one frame; returns the HUD it shows. */
function frame(
  session: Session,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  sprite: CanvasImageSource,
  dt: number,
  blinkOff: boolean,
): ArcadeHud {
  const wasOver = isOver(session.game);
  if (!session.paused) session.game = step(session.game, inputFrom(session.held), dt);
  if (!wasOver && isOver(session.game)) {
    session.endedAt = performance.now();
    session.hiScore = Math.max(session.hiScore, session.game.score);
    void saveHiScore(session.hiScore).then((best) => {
      session.hiScore = Math.max(session.hiScore, best);
    });
  }
  drawGame(ctx, session.game, canvas, sprite, blinkOff);
  return hudOf(session.game, Math.max(session.hiScore, session.game.score));
}

/** Runs Bug Invaders on `canvasRef` while mounted: owns the keyboard (capture phase),
 * pauses on window blur, and re-renders only when the HUD changes. */
export function useBugInvaders({
  canvasRef,
  makeBossSprite,
  reducedMotion,
  onQuit,
}: BugInvadersOptions): ArcadeHud {
  const [hud, setHud] = useState<ArcadeHud>(() => hudOf(createGame(), readHiScore()));
  const onQuitRef = useRef(onQuit);
  onQuitRef.current = onQuit;
  // Read live, so changing the motion preference mid-game never restarts it.
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    const session: Session = {
      game: createGame(),
      held: new Set(),
      hiScore: readHiScore(),
      endedAt: 0,
      paused: false,
    };
    const cleanups: Array<() => void> = [];
    const listen = <K extends keyof WindowEventMap>(
      type: K,
      handler: (e: WindowEventMap[K]) => void,
      capture = false,
    ) => {
      window.addEventListener(type, handler, { capture });
      cleanups.push(() => window.removeEventListener(type, handler, { capture }));
    };
    listen('keydown', (e) => onKeyDown(session, e, () => onQuitRef.current()), true);
    listen(
      'keyup',
      (e) => {
        session.held.delete(e.code);
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
      },
      true,
    );
    listen('blur', () => {
      session.held.clear();
      session.paused = true;
    });
    listen('focus', () => {
      session.paused = false;
    });

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      const sprite = makeBossSprite();
      fitCanvas(canvas);
      listen('resize', () => fitCanvas(canvas));
      let last = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        const dt = Math.min((now - last) / 1000, MAX_DT);
        last = now;
        const blinkOff = !reducedMotionRef.current && Math.floor(now / 100) % 2 === 0;
        const next = frame(session, ctx, canvas, sprite, dt, blinkOff);
        setHud((prev) => (sameHud(prev, next) ? prev : next));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      cleanups.push(() => cancelAnimationFrame(raf));
    }
    return () => cleanups.forEach((cleanup) => void cleanup());
  }, [canvasRef, makeBossSprite]);

  return hud;
}
