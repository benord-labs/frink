import { z } from 'zod';
import { formatFlowNodeLabel, validateGraph } from '../../../../../shared/lib/validate-flow-graph';
import {
  flowGraphEdgeSchema,
  flowGraphNodeSchema,
} from '../../../../../shared/types/flow-graph-schema';
import type { MobileFlowDefinition } from '../../../../../shared/types/remote/mobile';

const MAX_EDGES = 2500;
const MAX_DEFINITION_BYTES = 512 * 1024;
const definitionSchema = z.object({
  versionNumber: z.number().int().positive(),
  graph: z.object({
    nodes: z.array(
      flowGraphNodeSchema.omit({ position: true, size: true, config: true }).extend({
        config: z.object({ instructions: z.string().optional() }).catch({}).optional(),
      }),
    ),
    edges: z.array(flowGraphEdgeSchema),
  }),
});

function fitsTextBudget(values: Array<string | null | undefined>): boolean {
  let remaining = MAX_DEFINITION_BYTES;
  for (const value of values) {
    if (!value) continue;
    if (value.length > remaining) return false;
    remaining -= Buffer.byteLength(value, 'utf8');
    if (remaining < 0) return false;
  }
  return true;
}

type ParsedGraph = z.infer<typeof definitionSchema>['graph'];

function agentInstructions(node: ParsedGraph['nodes'][number]): string | null {
  return node.blockType === 'agent' && typeof node.config?.instructions === 'string'
    ? node.config.instructions
    : null;
}

function definitionText({ nodes, edges }: ParsedGraph): Array<string | null | undefined> {
  return [
    ...nodes.flatMap((node) => [
      node.id,
      node.label,
      node.blockType,
      node.parentId,
      agentInstructions(node),
    ]),
    ...edges.flatMap((edge) => [edge.id, edge.source, edge.target, edge.label, edge.sourceHandle]),
  ];
}

/** Project only authored prose and topology; commands, credentials and other config stay local. */
export function projectMobileFlowDefinition(
  graph: unknown,
  versionNumber: unknown,
): MobileFlowDefinition | null {
  const candidate = graph as { nodes?: unknown; edges?: unknown } | null;
  if (
    !candidate ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.edges) ||
    candidate.edges.length > MAX_EDGES
  )
    return null;
  const parsed = definitionSchema.safeParse({ graph, versionNumber });
  if (!parsed.success) return null;
  const parsedGraph = parsed.data.graph;
  // The desktop save validator owns topology; a graph it rejects would misrepresent the Flow,
  // so the whole definition is withheld rather than partly shown.
  if (!fitsTextBudget(definitionText(parsedGraph)) || !validateGraph(graph).valid) return null;
  const definition: MobileFlowDefinition = {
    versionNumber: parsed.data.versionNumber,
    nodes: parsedGraph.nodes.map((node) => ({
      id: node.id,
      label: formatFlowNodeLabel(node),
      blockType: node.blockType,
      parentId: node.parentId ?? null,
      instructions: agentInstructions(node),
    })),
    edges: parsedGraph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? null,
      sourceHandle: edge.sourceHandle ?? null,
    })),
  };
  return Buffer.byteLength(JSON.stringify(definition), 'utf8') <= MAX_DEFINITION_BYTES
    ? definition
    : null;
}
