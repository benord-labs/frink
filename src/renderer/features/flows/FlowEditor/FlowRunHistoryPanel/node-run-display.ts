import { getBlockRegistration } from '../../../../../shared/lib/block-registry';
import { formatFlowBlockTypeLabel } from '../../../../../shared/lib/format-flow-block-label';
import type { FlowGraph, FlowNode } from '../../../../../shared/lib/validate-flow-graph';
import { formatFlowNodeLabel } from '../../../../../shared/lib/validate-flow-graph';

/** Map node id → graph node for O(1) run-history label lookup. */
export function buildFlowNodeById(graph: FlowGraph | null): Map<string, FlowNode> {
  const m = new Map<string, FlowNode>();
  if (!graph?.nodes) return m;
  for (const n of graph.nodes) {
    m.set(n.id, n);
  }
  return m;
}

/** Short block kind for run history (registered label, else title-cased type id). */
function blockKindLabel(blockType: string): string {
  return getBlockRegistration(blockType)?.label ?? formatFlowBlockTypeLabel(blockType);
}

function normalizeLabelKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function labelsLookRedundant(a: string, b: string): boolean {
  const na = normalizeLabelKey(a);
  const nb = normalizeLabelKey(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

type FlowNodeRunDisplay = { title: string; kind: string | null };

/**
 * One scannable line: step title + optional kind badge when the kind adds information.
 * Omits kind when it duplicates the title (e.g. custom label vs hyphenated type id).
 */
export function flowNodeRunDisplay(
  blockType: string,
  node: FlowNode | undefined,
): FlowNodeRunDisplay {
  const kind = blockKindLabel(blockType);

  if (!node) {
    return { title: kind, kind: null };
  }

  const trimmed = typeof node.label === 'string' ? node.label.trim() : '';
  if (trimmed.length === 0) {
    return { title: formatFlowNodeLabel(node), kind: null };
  }

  if (labelsLookRedundant(trimmed, kind)) {
    return { title: trimmed, kind: null };
  }

  return { title: trimmed, kind };
}
