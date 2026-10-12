import type { FlowChangeAction, FlowChangeKind } from '../../types/flows/flow-change-presentation';

export type FlowPatchOperationShape = {
  action: FlowChangeAction;
  kind: FlowChangeKind;
};

const FLOW_PATCH_OPERATION_SHAPES = {
  add_node: { action: 'add', kind: 'node' },
  update_node: { action: 'update', kind: 'node' },
  remove_node: { action: 'remove', kind: 'node' },
  add_edge: { action: 'add', kind: 'edge' },
  update_edge: { action: 'update', kind: 'edge' },
  remove_edge: { action: 'remove', kind: 'edge' },
  update_settings: { action: 'update', kind: 'settings' },
  auto_layout: { action: 'update', kind: 'settings' },
} as const satisfies Record<string, FlowPatchOperationShape>;

export type FlowPatchOperationName = keyof typeof FLOW_PATCH_OPERATION_SHAPES;

export function flowPatchOperationShape(operation: FlowPatchOperationName): FlowPatchOperationShape;
export function flowPatchOperationShape(operation: unknown): FlowPatchOperationShape | undefined;
export function flowPatchOperationShape(operation: unknown): FlowPatchOperationShape | undefined {
  if (typeof operation !== 'string') return undefined;
  return FLOW_PATCH_OPERATION_SHAPES[operation as FlowPatchOperationName];
}
