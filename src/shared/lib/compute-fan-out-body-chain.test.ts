import { describe, expect, it } from 'vitest';
import { computeFanOutBodyChain, resolveFanOutStructure } from './compute-fan-out-body-chain';
import type { FlowEdge, FlowNode } from './validate-flow-graph';

/** A Fan Out with one body step and a continuation: complete in every other respect. */
function completeFanOut(parentId?: string) {
  const fan: FlowNode = { id: 'fan', blockType: 'fan_out' };
  if (parentId) fan.parentId = parentId;
  const nodes: FlowNode[] = [
    { id: 'outer', blockType: 'fan_out' },
    fan,
    { id: 'body', blockType: 'agent', parentId: 'fan' },
    { id: 'done', blockType: 'end' },
  ];
  const edges: FlowEdge[] = [
    { id: 'e1', source: 'fan', target: 'body' },
    { id: 'e2', source: 'body', target: 'done' },
  ];
  return { nodes, edges };
}

describe('resolveFanOutStructure — a Fan Out inside another Fan Out', () => {
  it('resolves a complete top-level Fan Out', () => {
    const { nodes, edges } = completeFanOut();
    const resolution = resolveFanOutStructure(nodes, edges, 'fan');

    expect(resolution.ok).toBe(true);
    expect(computeFanOutBodyChain(nodes, edges, 'fan')).toEqual(['body']);
  });

  it('refuses the same Fan Out once it is owned, as a hard failure not an unfinished draft', () => {
    const { nodes, edges } = completeFanOut('outer');
    const resolution = resolveFanOutStructure(nodes, edges, 'fan');

    expect(resolution).toEqual({
      ok: false,
      incomplete: false,
      message: expect.stringContaining('(id "fan") cannot sit inside another Fan Out'),
    });
  });

  it('gives an owned Fan Out no body chain, so nothing treats its steps as per-item work', () => {
    const { nodes, edges } = completeFanOut('outer');

    expect(computeFanOutBodyChain(nodes, edges, 'fan')).toEqual([]);
  });
});
