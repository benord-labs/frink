import { describe, expect, it } from 'vitest';
import type {
  FlowPatchReasonCode,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import { describeFlowChange } from './index';

function nodeChange(
  action: FlowSemanticChange['action'],
  status: FlowSemanticChange['status'],
  reasonCode?: FlowPatchReasonCode,
): FlowSemanticChange {
  const change: FlowSemanticChange = {
    operationIndex: 0,
    action,
    kind: 'node',
    status,
    label: 'step',
    nodeId: 'step',
  };
  if (reasonCode) change.reasonCode = reasonCode;
  return change;
}

describe('describeFlowChange — reason codes', () => {
  it('explains a cascade-removed step as needing no change rather than a bare failure', () => {
    const change = nodeChange('remove', 'skipped', 'cascade-removed');

    expect(describeFlowChange(change)).toMatch(/already removed with an earlier step/);
    expect(describeFlowChange(change)).not.toMatch(/Did not remove/);
  });

  it('keeps reason copy free of operation indexes and patch verbs', () => {
    const codes: FlowPatchReasonCode[] = ['cascade-removed', 'dependency-failed', 'stale-parent'];
    const text = codes
      .flatMap((reasonCode) =>
        (['add', 'remove', 'update'] as const).map((action) =>
          describeFlowChange(nodeChange(action, 'failed', reasonCode)),
        ),
      )
      .join(' ');

    expect(text).not.toMatch(/Operation \d|remove_node|add_node|add_edge|parentId/);
  });

  it('falls back to status copy when the reason code is not one it knows', () => {
    // SAFETY: deliberately an unlisted code — stored receipts can carry one from another build,
    // and the assertion is the only way to reach that runtime path from typed test data.
    const change = nodeChange('remove', 'skipped', 'from-a-newer-build' as FlowPatchReasonCode);

    expect(() => describeFlowChange(change)).not.toThrow();
    expect(describeFlowChange(change)).toBe('Did not remove this step');
  });
});

describe('describeFlowChange — inconsistent receipts', () => {
  it('ignores a reason code on an applied change rather than calling it a no-op', () => {
    const change = nodeChange('add', 'applied', 'cascade-removed');

    expect(describeFlowChange(change)).not.toMatch(/already removed/);
  });
});
