import { describe, expect, it } from 'vitest';
import { flowGraphNodeSchema } from './flow-graph-schema';

describe('flowGraphNodeSchema', () => {
  it('preserves Fan Out body ownership', () => {
    expect(
      flowGraphNodeSchema.parse({ id: 'body', blockType: 'agent', parentId: 'fan-out' }),
    ).toMatchObject({ parentId: 'fan-out' });
  });

  it('keeps a Fan Out container size and rejects non-positive or non-finite sizes', () => {
    const node = { id: 'fan', blockType: 'fan_out' };
    expect(flowGraphNodeSchema.parse({ ...node, size: { width: 900, height: 500 } }).size).toEqual({
      width: 900,
      height: 500,
    });
    for (const size of [
      { width: -5, height: 500 },
      { width: 900, height: 0 },
      { width: Number.NaN, height: 500 },
      { width: 900, height: Number.POSITIVE_INFINITY },
    ]) {
      expect(flowGraphNodeSchema.safeParse({ ...node, size }).success).toBe(false);
    }
  });
});
