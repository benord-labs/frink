import { describe, expect, it } from 'vitest';
import { flowPatchOperationShape } from './flow-patch-operation-shape';

describe('flowPatchOperationShape', () => {
  it.each([
    ['add_node', { action: 'add', kind: 'node' }],
    ['update_node', { action: 'update', kind: 'node' }],
    ['remove_node', { action: 'remove', kind: 'node' }],
    ['add_edge', { action: 'add', kind: 'edge' }],
    ['update_edge', { action: 'update', kind: 'edge' }],
    ['remove_edge', { action: 'remove', kind: 'edge' }],
    ['update_settings', { action: 'update', kind: 'settings' }],
    ['auto_layout', { action: 'update', kind: 'settings' }],
  ] as const)('maps %s to its semantic change shape', (operation, expected) => {
    expect(flowPatchOperationShape(operation)).toEqual(expected);
  });

  it('rejects unknown operation names', () => {
    expect(flowPatchOperationShape('run_flow')).toBeUndefined();
    expect(flowPatchOperationShape(null)).toBeUndefined();
  });
});
