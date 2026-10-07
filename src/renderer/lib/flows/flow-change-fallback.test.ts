import { describe, expect, it } from 'vitest';
import { describeFallbackFlowChange } from './flow-change-fallback';

describe('describeFallbackFlowChange', () => {
  it('describes a layout reset before a receipt exists', () => {
    const change = describeFallbackFlowChange(
      { op: 'auto_layout' },
      0,
      { nodes: [], edges: [] },
      'pending',
    );
    expect(change).toMatchObject({
      action: 'update',
      kind: 'settings',
      label: 'Canvas layout',
      detail: 'Reset to automatic layout',
    });
  });
});
