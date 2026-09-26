import type { NodeChange } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { collectFinishedResizes, type ResizeMoves } from './collect-finished-resizes';

const size = { width: 900, height: 600 };
const resizing = (id: string): NodeChange => ({
  id,
  type: 'dimensions',
  resizing: true,
  setAttributes: true,
  dimensions: size,
});
const end = (id: string): NodeChange => ({
  id,
  type: 'dimensions',
  resizing: false,
  dimensions: size,
});
const moveTo = (id: string, x: number, y: number): NodeChange => ({
  id,
  type: 'position',
  position: { x, y },
});

describe('collectFinishedResizes', () => {
  it('commits the final size with the latest position of every node a top/left resize moved', () => {
    const moves: ResizeMoves = new Map();
    collectFinishedResizes(
      [moveTo('fan', 10, 10), resizing('fan'), moveTo('child', 50, 170)],
      moves,
    );
    collectFinishedResizes([moveTo('fan', 0, 0), resizing('fan'), moveTo('child', 60, 180)], moves);

    expect(collectFinishedResizes([end('fan')], moves)).toEqual([
      {
        id: 'fan',
        size,
        positions: [
          { id: 'fan', position: { x: 0, y: 0 } },
          { id: 'child', position: { x: 60, y: 180 } },
        ],
      },
    ]);
    expect(moves.size).toBe(0);
  });

  it('commits a right/bottom resize with no moved positions', () => {
    const moves: ResizeMoves = new Map();
    collectFinishedResizes([resizing('fan')], moves);
    expect(collectFinishedResizes([end('fan')], moves)).toEqual([
      { id: 'fan', size, positions: [] },
    ]);
  });

  it('ignores an end event with no resize before it (a click on a handle)', () => {
    expect(collectFinishedResizes([end('fan')], new Map())).toEqual([]);
  });

  it('ignores measurement and drag changes that are not resizes', () => {
    const moves: ResizeMoves = new Map();
    const measured: NodeChange = { id: 'a', type: 'dimensions', dimensions: size };
    expect(collectFinishedResizes([measured, moveTo('a', 1, 2)], moves)).toEqual([]);
    expect(moves.size).toBe(0);
  });
});
