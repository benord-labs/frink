import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import { buildFlowNodeById, flowNodeRunDisplay } from './node-run-display';

describe('flowNodeRunDisplay', () => {
  it('shows title and kind when custom label differs from block kind', () => {
    expect(
      flowNodeRunDisplay('run_command', {
        id: 'n1',
        blockType: 'run_command',
        label: '  Checkout branch  ',
      }),
    ).toEqual({ title: 'Checkout branch', kind: 'Run Command' });
  });

  it('uses registered default as title when node has no label', () => {
    expect(
      flowNodeRunDisplay('condition', {
        id: 'n1',
        blockType: 'condition',
      }),
    ).toEqual({ title: 'Condition', kind: null });
  });

  it('uses registered default when label is whitespace only', () => {
    expect(
      flowNodeRunDisplay('agent', {
        id: 'n1',
        blockType: 'agent',
        label: '   ',
      }),
    ).toEqual({ title: 'Agent', kind: null });
  });

  it('treats missing node as block-kind title only', () => {
    expect(flowNodeRunDisplay('end', undefined)).toEqual({
      title: 'End',
      kind: null,
    });
  });

  it('ignores non-string label (corrupt JSON) and uses block kind as title only', () => {
    const node = {
      id: 'n1',
      blockType: 'run_command',
      label: 123,
    } as unknown as FlowNode;
    expect(flowNodeRunDisplay('run_command', node)).toEqual({
      title: 'Run Command',
      kind: null,
    });
  });

  it('omits kind when custom label matches block kind text (no redundant second line)', () => {
    expect(
      flowNodeRunDisplay('condition', {
        id: 'n1',
        blockType: 'condition',
        label: 'Condition',
      }),
    ).toEqual({ title: 'Condition', kind: null });
  });

  it('omits kind when label matches hyphenated custom block type (normalized)', () => {
    expect(
      flowNodeRunDisplay('check-new-prs', {
        id: 'n1',
        blockType: 'check-new-prs',
        label: 'Check new PRs',
      }),
    ).toEqual({ title: 'Check new PRs', kind: null });
  });
});

describe('buildFlowNodeById', () => {
  it('returns empty map for null graph', () => {
    expect(buildFlowNodeById(null).size).toBe(0);
  });

  it('indexes nodes by id', () => {
    const graph = {
      nodes: [
        { id: 'a', blockType: 'manual_trigger', label: 'T' },
        { id: 'b', blockType: 'end' },
      ],
      edges: [],
    };
    const m = buildFlowNodeById(graph);
    expect(m.get('a')?.label).toBe('T');
    expect(m.get('b')?.blockType).toBe('end');
  });
});
