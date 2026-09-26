// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChalkboardControls } from './summon-choreography';
import { useChalkboardProof } from './use-chalkboard-proof';

function stillBoard(): ChalkboardControls {
  const never = () => new Promise<void>(() => {});
  return {
    unroll: vi.fn(never),
    write: vi.fn(never),
    reveal: vi.fn(),
    circleAnswer: vi.fn(never),
    rollUp: vi.fn(),
    fadeOut: vi.fn(),
  };
}

function renderProof(board: ChalkboardControls, active: boolean) {
  return renderHook(
    ({ on }) =>
      useChalkboardProof({
        active: on,
        reducedMotion: false,
        boardRef: { current: board },
        setPose: () => {},
        followRef: { current: null },
        onDone: () => {},
      }),
    { initialProps: { on: active }, wrapper: StrictMode },
  );
}

describe('useChalkboardProof', () => {
  it('keeps the board up through a Strict Mode re-run', () => {
    const board = stillBoard();
    renderProof(board, true);
    expect(board.unroll).toHaveBeenCalled();
    expect(board.fadeOut).not.toHaveBeenCalled();
  });

  it('fades the board once when the summon ends before the answer', () => {
    const board = stillBoard();
    const { rerender } = renderProof(board, true);
    rerender({ on: false });
    expect(board.fadeOut).toHaveBeenCalledOnce();
  });

  it('never fades a board that was not shown', () => {
    const board = stillBoard();
    renderProof(board, false);
    expect(board.fadeOut).not.toHaveBeenCalled();
  });
});
