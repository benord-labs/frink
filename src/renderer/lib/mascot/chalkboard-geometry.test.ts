import { describe, expect, it } from 'vitest';
import { ANSWER_INDEX, BOARD_VIEWBOX, boardLines, ringPath } from './chalkboard-geometry';

const STATS = { commits: 10, insertions: 412, deletions: 97 };

describe('chalkboard geometry', () => {
  it('ends with the answer Frink circles, with or without stats', () => {
    for (const lines of [boardLines(), boardLines(STATS)]) {
      expect(ANSWER_INDEX).toBe(lines.length - 1);
      expect(lines[ANSWER_INDEX]?.text).toContain('review');
    }
  });

  it('writes the real diffstat only when stats are given', () => {
    expect(boardLines(STATS)[1]?.text).toBe('∂code/∂t = +412 − 97');
    expect(
      boardLines()
        .map((l) => l.text)
        .join(),
    ).not.toMatch(/\+\d/);
    expect(boardLines(null)).toEqual(boardLines());
  });

  it('keeps every line inside the board', () => {
    for (const line of boardLines(STATS)) {
      expect(line.y).toBeLessThan(BOARD_VIEWBOX.height);
      expect(line.y - line.size).toBeGreaterThan(0);
    }
  });

  it('draws the ring around the box it is given', () => {
    const box = { x: 150, y: 160, width: 100, height: 26 };
    const points = ringPath(box)
      .slice(1)
      .split(' L')
      .map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(71);
    const xs = points.map(([x = 0]) => x);
    const ys = points.map(([, y = 0]) => y);
    expect(Math.min(...xs)).toBeLessThan(box.x);
    expect(Math.max(...xs)).toBeGreaterThan(box.x + box.width);
    expect(Math.min(...ys)).toBeLessThan(box.y);
    expect(Math.max(...ys)).toBeGreaterThan(box.y + box.height);
  });
});
