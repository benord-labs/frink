import { getBlockRegistration } from '../../../../src/shared/lib/block-registry';
import { findBackEdges } from '../../../../src/shared/lib/flow-graph-cycle';
import type { MobileFlowDefinition } from '../../../../src/shared/types/remote/mobile';
import { humanize } from '../../lib/status';

type Node = MobileFlowDefinition['nodes'][number];
type Edge = MobileFlowDefinition['edges'][number];
/** One line under a step. `target` is the step it leads to, when the line is a connection. */
export type OutlineLine = {
  kind: 'branch' | 'loop' | 'jump' | 'note';
  text: string;
  target?: string;
};
export type OutlineStep = { node: Node; type: string; lines: OutlineLine[] };

/** Desktop block names are Title Case; iOS reads sentence case. Acronyms (HTTP) keep their caps. */
function sentenceCase(label: string): string {
  return label.replace(
    /(?<=\s|-)([A-Z])([a-z]+)/g,
    (_, first: string, rest: string) => first.toLowerCase() + rest,
  );
}

function edgeLine(edge: Edge, loop: boolean, nameFor: (id: string) => string): OutlineLine {
  const label = edge.label || (edge.sourceHandle ? `If ${edge.sourceHandle}` : null);
  const target = nameFor(edge.target);
  if (loop) return { kind: 'loop', text: `${label ? `${label} · ` : ''}Returns to`, target };
  return label
    ? { kind: 'branch', text: `${label}:`, target }
    : { kind: 'jump', text: 'Then', target };
}

/**
 * The saved definition as a readable list. The list order already says "next", so a plain edge
 * to the following step is left out; branches, loops, jumps, joins and dead ends are spelled out.
 */
export function outlineSteps(definition: MobileFlowDefinition): OutlineStep[] {
  const { nodes, edges } = definition;
  const loops = findBackEdges(definition);
  const nameFor = (id: string) => nodes.find((node) => node.id === id)?.label ?? id;
  const branches = nodes.some((node) => edges.filter((e) => e.source === node.id).length > 1);
  return nodes.map((node, index) => {
    const outgoing = edges.filter((edge) => edge.source === node.id);
    const incoming = edges.filter((edge) => edge.target === node.id && !loops.has(edge.id));
    const lines: OutlineLine[] = [];
    if (node.parentId) lines.push({ kind: 'note', text: `Inside ${nameFor(node.parentId)}` });
    if (incoming.length > 1)
      lines.push({
        kind: 'note',
        text: `Joins from ${incoming.map((edge) => nameFor(edge.source)).join(' · ')}`,
      });
    const implied =
      outgoing.length === 1 &&
      !loops.has(outgoing[0].id) &&
      !outgoing[0].label &&
      !outgoing[0].sourceHandle &&
      outgoing[0].target === nodes[index + 1]?.id;
    if (!implied)
      for (const edge of outgoing) lines.push(edgeLine(edge, loops.has(edge.id), nameFor));
    if (!outgoing.length && !incoming.length && !node.parentId && nodes.length > 1)
      lines.push({ kind: 'note', text: 'Not connected' });
    else if (!outgoing.length && branches) lines.push({ kind: 'note', text: 'End of this path' });
    return {
      node,
      type: sentenceCase(getBlockRegistration(node.blockType)?.label ?? humanize(node.blockType)),
      lines,
    };
  });
}
