import type { FlowGraph } from './validate-flow-graph';

/**
 * When the flow-level default project changes, clear `config.projectId` on any
 * node whose override matched the **previous** default so it inherits the new one.
 * Nodes with a genuinely different override (or no override at all) are untouched.
 */
export function reconcileNodeProjectsOnDefaultChange(
  graph: FlowGraph,
  prevDefaultProjectId: string | undefined,
  nextDefaultProjectId: string | undefined,
): FlowGraph {
  const prevNorm = prevDefaultProjectId?.trim() ?? '';
  const nextNorm = nextDefaultProjectId?.trim() ?? '';
  if (prevNorm === nextNorm || prevNorm === '') return graph;

  const nextNodes = graph.nodes.map((n) => {
    const raw =
      n.config && typeof n.config === 'object' && !Array.isArray(n.config)
        ? (n.config as Record<string, unknown>)
        : {};
    const nodePid = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
    if (nodePid === '' || nodePid !== prevNorm) return n;
    const rest = { ...raw };
    delete rest.projectId;
    return { ...n, config: Object.keys(rest).length > 0 ? rest : undefined };
  });

  return { ...graph, nodes: nextNodes };
}
