import type { FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import { isPlainObject } from '../../../../../shared/lib/case-converter/is-transformable';
import { deepMergePatch } from '../deep-merge-patch';
import type { PatchOperation } from '../flow-patch';

type AddNodeOp = Extract<PatchOperation, { op: 'add_node' }>;
type UpdateNodeOp = Extract<PatchOperation, { op: 'update_node' }>;

/** Mirrors the save-mode nesting rule, so one bad op fails instead of the whole batch. */
export const nestsFanOut = (blockType: string, parentId: unknown): boolean =>
  blockType === 'fan_out' && typeof parentId === 'string';

/** `size` is a Fan Out container's canvas size; on any other node it is an authoring error. */
export function sizeOnNonFanOutError(
  prefix: string,
  node: Pick<FlowNode, 'id' | 'blockType'>,
  size: unknown,
): string | undefined {
  if (size === undefined || node.blockType === 'fan_out') return undefined;
  return `${prefix}: size applies only to Fan Out nodes; '${node.id}' is ${node.blockType}`;
}

/** Copies an `add_node` payload into a fresh node, keeping only the fields the graph stores. */
export function buildAddedNode(raw: AddNodeOp['node']): FlowNode {
  return {
    id: raw.id,
    blockType: raw.blockType,
    ...(raw.parentId !== undefined ? { parentId: raw.parentId } : {}),
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.config !== undefined ? { config: { ...raw.config } } : {}),
    ...(raw.position !== undefined ? { position: { ...raw.position } } : {}),
    ...(raw.size !== undefined ? { size: { ...raw.size } } : {}),
  };
}

/**
 * Applies one `update_node` op in place; `config` deep-merges, and `parentId: null` /
 * `size: null` clear the field.
 */
export function applyNodeUpdate(node: FlowNode, op: UpdateNodeOp): void {
  if (op.label !== undefined) node.label = op.label;
  if (op.position !== undefined) node.position = { ...op.position };
  if (op.size === null) delete node.size;
  else if (op.size !== undefined) node.size = { ...op.size };
  if (op.parentId === null) delete node.parentId;
  else if (op.parentId !== undefined) node.parentId = op.parentId;
  if (op.config === undefined) return;
  const base = isPlainObject(node.config) ? (node.config as Record<string, unknown>) : {};
  node.config = deepMergePatch(base, op.config as Record<string, unknown>);
}
