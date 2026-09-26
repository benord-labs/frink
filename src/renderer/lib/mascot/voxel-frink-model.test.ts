import { describe, expect, it } from 'vitest';
import { buildVoxelFrink, MODEL_HEIGHT } from './voxel-frink-model';

describe('buildVoxelFrink', () => {
  const parts = buildVoxelFrink();

  it('lists every parent before its children so groups can be built in order', () => {
    const seen = new Set<string>();
    for (const part of parts) {
      if (part.parent) expect(seen.has(part.parent)).toBe(true);
      seen.add(part.name);
    }
  });

  it('never stacks two cubes on one grid cell within a part', () => {
    for (const part of parts) {
      const cells = part.voxels.map((v) => `${v.x},${v.y},${v.z}`);
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it('keeps the pupils out of the head so blinking can squash them', () => {
    const head = parts.find((p) => p.name === 'head');
    const eyes = parts.find((p) => p.name === 'eyes');
    const headCells = new Set(head?.voxels.map((v) => `${v.x},${v.y},${v.z}`));
    expect(eyes?.voxels).toHaveLength(2);
    for (const pupil of eyes?.voxels ?? []) {
      expect(headCells.has(`${pupil.x},${pupil.y},${pupil.z}`)).toBe(false);
    }
  });

  it('fits under MODEL_HEIGHT, which orders the assemble and explode waves', () => {
    const top = Math.max(...parts.flatMap((p) => p.voxels.map((v) => v.y)));
    expect(top).toBe(MODEL_HEIGHT);
  });

  it('hinges each leg at the hip so the walk can swing it', () => {
    for (const name of ['legL', 'legR'] as const) {
      const leg = parts.find((p) => p.name === name);
      expect(leg?.voxels.length).toBeGreaterThan(0);
      const top = Math.max(...(leg?.voxels.map((v) => v.y) ?? []));
      expect(top).toBeLessThan(leg?.pivot[1] ?? 0);
    }
    const body = parts.find((p) => p.name === 'body');
    expect(Math.min(...(body?.voxels.map((v) => v.y) ?? []))).toBe(5);
  });
});
