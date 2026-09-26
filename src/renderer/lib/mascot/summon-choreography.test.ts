import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_INDEX } from './chalkboard-geometry';
import {
  type ChalkboardControls,
  type ChalkboardProof,
  frinkBuildFor,
  glideFrink,
  poseForPhase,
  runChalkboardProof,
} from './summon-choreography';

function fakeBoard(): ChalkboardControls & { written: number[] } {
  const written: number[] = [];
  return {
    written,
    unroll: vi.fn(async () => {}),
    write: vi.fn(async (index, _token, onTip) => {
      written.push(index);
      onTip({ x: index, y: index });
    }),
    reveal: vi.fn(),
    circleAnswer: vi.fn(async () => {}),
    rollUp: vi.fn(),
    fadeOut: vi.fn(),
  };
}

function proof(board: ChalkboardControls, overrides: Partial<ChalkboardProof> = {}) {
  const p: ChalkboardProof = {
    board,
    token: { cancelled: false },
    reducedMotion: false,
    setPose: vi.fn(),
    follow: vi.fn(),
    ...overrides,
  };
  return { p };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runChalkboardProof', () => {
  it('writes every line at a readable pace, circles the answer, holds it, then rolls up', async () => {
    const board = fakeBoard();
    const { p } = proof(board);
    const done = runChalkboardProof(p);

    await vi.advanceTimersByTimeAsync(1000);
    expect(board.written).toEqual([0, 1, 2]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(board.written).toEqual([0, 1, 2, 3, ANSWER_INDEX]);
    expect(board.circleAnswer).toHaveBeenCalledOnce();
    expect(board.rollUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(true);
    expect(board.rollUp).toHaveBeenCalledOnce();
    expect(p.follow).toHaveBeenLastCalledWith(null);
  });

  it('reveals lines instead of writing them under reduced motion, and holds them longer', async () => {
    const board = fakeBoard();
    const { p } = proof(board, { reducedMotion: true });
    const done = runChalkboardProof(p);
    await vi.advanceTimersByTimeAsync(3000);
    expect(board.rollUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    await done;

    expect(board.write).not.toHaveBeenCalled();
    expect(board.reveal).toHaveBeenLastCalledWith(ANSWER_INDEX + 1);
    expect(board.rollUp).toHaveBeenCalledOnce();
  });

  it('stops when the summon is dismissed mid-proof', async () => {
    const board = fakeBoard();
    const token = { cancelled: false };
    const { p } = proof(board, { token });
    const done = runChalkboardProof(p);

    await vi.advanceTimersByTimeAsync(500);
    token.cancelled = true;
    await vi.advanceTimersByTimeAsync(5000);

    await expect(done).resolves.toBe(false);
    expect(board.circleAnswer).not.toHaveBeenCalled();
    expect(board.rollUp).not.toHaveBeenCalled();
  });
});

describe('frinkBuildFor', () => {
  it('assembles on arrival and explodes on the way out', () => {
    expect(frinkBuildFor('walk-in', false)).toBe('assemble');
    expect(frinkBuildFor('summoning', false)).toBe('assemble');
    expect(frinkBuildFor('walk-out', false)).toBe('explode');
  });

  it('appears and disappears without cubes flying under reduced motion', () => {
    expect(frinkBuildFor('walk-in', true)).toBe('solid');
    expect(frinkBuildFor('done', true)).toBe('hidden');
  });
});

describe('glideFrink', () => {
  const home = { x: 100, y: 500 };

  it('settles within a fraction of a second so the chalk tip lands on the write point', () => {
    let pos = home;
    for (let frame = 0; frame < 30; frame++) {
      pos = glideFrink({
        pos,
        home,
        follow: { x: 400, y: 450 },
        tip: { x: 120, y: 10 },
        dt: 0.016,
      }).pos;
    }
    expect(pos.x).toBeCloseTo(280, 0);
    expect(pos.y).toBeCloseTo(440, 0);
  });

  it('never sinks below the floor, even for a low write point', () => {
    const { pos, lift } = glideFrink({
      pos: home,
      home,
      follow: { x: 400, y: 900 },
      tip: { x: 120, y: 10 },
      dt: 0.016,
    });
    expect(pos.y).toBe(home.y);
    expect(lift).toBe(0);
  });

  it('drifts back home when not writing', () => {
    const { pos, lift } = glideFrink({
      pos: { x: 300, y: 300 },
      home,
      follow: null,
      tip: { x: 0, y: 0 },
      dt: 0.016,
    });
    expect(pos.x).toBeLessThan(300);
    expect(pos.y).toBeGreaterThan(300);
    expect(lift).toBeGreaterThan(0);
  });
});

describe('poseForPhase', () => {
  it('cheers the answer and stands to leave', () => {
    expect(poseForPhase('reacting')).toBe('cheer');
    expect(poseForPhase('walk-out')).toBe('stand');
    expect(poseForPhase('summoning')).toBeNull();
  });
});
