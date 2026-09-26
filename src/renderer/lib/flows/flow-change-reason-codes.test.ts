import { describe, expect, it } from 'vitest';
import { buildFlowChangePresentation } from './flow-change-presentation';

function partialReceipt(reasonCode: string) {
  return {
    state: 'output-available' as const,
    input: { flowId: 'flow-1', operations: [{ op: 'remove_node', nodeId: 'body' }] },
    result: {
      status: 'partial',
      persistence: 'saved',
      flowId: 'flow-1',
      name: 'Release train',
      versionNumber: 4,
      graph: { nodes: [], edges: [] },
      flowChange: {
        schemaVersion: 1,
        mode: 'update',
        baseVersionNumber: 3,
        versionNumber: 4,
        changes: [
          {
            operationIndex: 0,
            action: 'remove',
            kind: 'node',
            status: 'skipped',
            reasonCode,
            label: 'Body step',
          },
        ],
      },
    },
  };
}

describe('buildFlowChangePresentation — patch reason codes', () => {
  it('carries a known reason code from the receipt through to the presentation', () => {
    const presentation = buildFlowChangePresentation(partialReceipt('cascade-removed'));

    expect(presentation.changes[0]?.reasonCode).toBe('cascade-removed');
  });

  it('drops an unrecognised reason code rather than trusting the payload', () => {
    const presentation = buildFlowChangePresentation(partialReceipt('not-a-real-code'));

    expect(presentation.changes[0]?.reasonCode).toBeUndefined();
    expect(presentation.changes[0]?.status).toBe('skipped');
  });
});
