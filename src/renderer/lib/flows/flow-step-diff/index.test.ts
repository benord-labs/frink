import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type {
  FlowChangePresentation,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import { buildFlowChangeOutline } from '../flow-change-outline';
import { buildStepChanges, stepDiffVersionKey } from './index';

function update(nodeId: string, operationIndex = 0): FlowSemanticChange {
  return {
    operationIndex,
    action: 'update',
    kind: 'node',
    status: 'applied',
    label: nodeId,
    nodeId,
  };
}

function receipt(overrides: Partial<FlowChangePresentation> = {}): FlowChangePresentation {
  return {
    flowId: 'flow-1',
    name: 'frink-work',
    mode: 'update',
    phase: 'applied',
    baseVersionNumber: 77,
    versionNumber: 78,
    graph: {
      nodes: [
        { id: 'gate', blockType: 'condition', label: 'Project = devkit?' },
        { id: 'ship', blockType: 'agent', label: 'Ship PR' },
        { id: 'edge', blockType: 'agent', label: 'Edge Cases' },
      ],
      edges: [
        { id: 'e1', source: 'gate', target: 'ship', sourceHandle: 'true', label: 'If yes' },
        { id: 'e2', source: 'gate', target: 'edge', sourceHandle: 'false', label: 'If no' },
      ],
    },
    changes: [update('ship')],
    warningCount: 0,
    ...overrides,
  };
}

function graph(shipInstructions: string, edgeModel = 'sonnet'): FlowGraph {
  return {
    nodes: [
      { id: 'gate', blockType: 'condition', label: 'Project = devkit?' },
      {
        id: 'ship',
        blockType: 'agent',
        label: 'Ship PR',
        config: { instructions: shipInstructions },
      },
      { id: 'edge', blockType: 'agent', label: 'Edge Cases', config: { model: edgeModel } },
    ],
    edges: [],
  };
}

describe('stepDiffVersionKey', () => {
  it('pins the pair only when the receipt proves the patch saved exactly base + 1', () => {
    expect(stepDiffVersionKey(receipt())).toEqual({ flowId: 'flow-1', baseVersionNumber: 77 });
    expect(stepDiffVersionKey(receipt({ versionNumber: 79 }))).toBeUndefined();
    expect(stepDiffVersionKey(receipt({ baseVersionNumber: undefined }))).toBeUndefined();
  });

  it('skips created flows, unsaved phases and receipts with no applied step update', () => {
    expect(stepDiffVersionKey(receipt({ mode: 'create' }))).toBeUndefined();
    expect(stepDiffVersionKey(receipt({ phase: 'proposed' }))).toBeUndefined();
    expect(
      stepDiffVersionKey(receipt({ changes: [{ ...update('ship'), status: 'failed' }] })),
    ).toBeUndefined();
  });
});

describe('buildStepChanges', () => {
  it('lists each changed step once, with the branch it sits on', () => {
    const presentation = receipt({ changes: [update('ship', 0), update('ship', 1)] });
    const outline = buildFlowChangeOutline(presentation);

    const entries = buildStepChanges(
      presentation,
      { before: graph('Open a PR.'), after: graph('Open a PR. Attach screenshots.') },
      outline.routes,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ nodeId: 'ship', label: 'Ship PR', path: ['If yes'] });
    expect(entries[0]?.fields[0]).toMatchObject({ kind: 'text', label: 'Instructions' });
  });

  it('drops steps missing from either version and steps whose saved fields did not change', () => {
    const presentation = receipt({
      changes: [update('ship'), update('edge', 1), update('gone', 2)],
    });

    const entries = buildStepChanges(
      presentation,
      { before: graph('Same', 'sonnet'), after: graph('Same', 'opus') },
      [],
    );

    expect(entries.map((entry) => entry.nodeId)).toEqual(['edge']);
  });

  it('skips a step that was removed and re-added under the same id, since it is a new step', () => {
    const replaced = (action: 'add' | 'remove', operationIndex: number) => ({
      ...update('ship', operationIndex),
      action,
    });
    const presentation = receipt({
      changes: [replaced('remove', 0), replaced('add', 1), update('ship', 2)],
    });

    const entries = buildStepChanges(
      presentation,
      { before: graph('Old step'), after: graph('Brand new step') },
      [],
    );

    expect(entries).toEqual([]);
  });

  it('still lists an applied update when the same patch failed to remove that step', () => {
    const failedRemove: FlowSemanticChange = {
      ...update('ship', 0),
      action: 'remove',
      status: 'failed',
    };
    const presentation = receipt({ changes: [failedRemove, update('ship', 1)] });

    const entries = buildStepChanges(
      presentation,
      { before: graph('Open a PR.'), after: graph('Open a PR. Attach screenshots.') },
      [],
    );

    expect(entries.map((entry) => entry.nodeId)).toEqual(['ship']);
  });
});
