// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { ANSWER_INDEX, boardLines } from '@/lib/mascot/chalkboard-geometry';
import type { ChalkboardControls } from '@/lib/mascot/summon-choreography';
import { Chalkboard } from './index';

function revealedLines(container: HTMLElement): number {
  return [...container.querySelectorAll('clipPath rect')].filter(
    (rect) => rect.getAttribute('width') !== '0',
  ).length;
}

function renderBoard() {
  const ref = createRef<ChalkboardControls>();
  const view = render(<Chalkboard ref={ref} style={{}} lines={boardLines()} />);
  return { ...view, board: ref };
}

describe('Chalkboard', () => {
  it('starts blank and hidden', () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll('text')).toHaveLength(ANSWER_INDEX + 1);
    expect(revealedLines(container)).toBe(0);
    expect(container.querySelector('.invisible')).not.toBeNull();
  });

  it('shows itself when unrolled', async () => {
    const { container, board } = renderBoard();
    await board.current?.unroll({ cancelled: false }, true);
    expect(container.querySelector('.invisible')).toBeNull();
  });

  it('reveals only the lines asked for, keeping the answer back', () => {
    const { container, board } = renderBoard();
    board.current?.reveal(ANSWER_INDEX);
    expect(revealedLines(container)).toBe(ANSWER_INDEX);
  });

  it('keeps revealed lines when real stats arrive late', () => {
    const { container, board, rerender } = renderBoard();
    board.current?.reveal(ANSWER_INDEX);
    const stats = { commits: 10, insertions: 412, deletions: 97 };
    rerender(<Chalkboard ref={board} style={{}} lines={boardLines(stats)} />);
    expect(container.textContent).toContain('+412 − 97');
    expect(revealedLines(container)).toBe(ANSWER_INDEX);
  });
});
