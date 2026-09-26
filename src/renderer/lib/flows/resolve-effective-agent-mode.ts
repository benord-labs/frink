/**
 * Resolves the mode an agent node actually RUNS in, for surfaces that must treat an inheriting
 * node the same way dispatch does.
 *
 * An agent node's `config.mode` is an OVERRIDE, not the effective mode: left unset (the editor's
 * default, "Inherit from Start Task") the node inherits the upstream start_task's `startMode`.
 * Reading `config.mode` alone therefore reports an inheriting node as "not plan" and silently
 * strips a plan-gated node of its approval affordance. Dispatch applies the full rule in
 * `src/main/lib/flows/dispatch/agent.ts` (`config.mode ?? stc.startMode`); this is its read-side
 * twin for the renderer, resolved from the run's own graph snapshot.
 *
 * Where branches merge, which start_task wins depends on `edges` array order. Per-branch
 * disambiguation for multi-start_task DAGs is deliberately out of scope.
 */
import { type ChatStartMode, toChatMode } from '../../../shared/lib/trigger-rule-config';

type GraphNode = {
  id: string;
  blockType?: string;
  config?: Record<string, unknown>;
};

type GraphEdge = { source: string; target: string };

type ResolvableGraph = {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
} | null;

/**
 * Nearest start_task reachable by walking edges backwards from `nodeId`. Depth-first in `edges`
 * order so it matches cloud's traversal; `visited` makes a cyclic graph terminate rather than
 * recurse forever.
 */
function findUpstreamStartTask(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  nodeId: string,
  visited: Set<string>,
): GraphNode | undefined {
  if (visited.has(nodeId)) return undefined;
  visited.add(nodeId);
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const predecessor = nodes.find((node) => node.id === edge.source);
    if (!predecessor) continue;
    if (predecessor.blockType === 'start_task') return predecessor;
    const found = findUpstreamStartTask(nodes, edges, predecessor.id, visited);
    if (found) return found;
  }
  return undefined;
}

/** A start_task's raw `startMode` narrowed to the agent-node vocabulary. */
function startModeToChatMode(startMode: unknown): ChatStartMode {
  // 'wait' keeps a task queued and never executes it, so it can never be an active plan gate —
  // it collapses into 'agent' alongside 'execute' and any unrecognised value.
  return toChatMode(startMode === 'plan' || startMode === 'debug' ? startMode : 'execute');
}

/**
 * The effective mode of the agent node `nodeId`: its own override when set, else the inherited
 * upstream start_task mode. Returns undefined when the node is absent from the graph or has no
 * upstream start_task — callers should read that as "cannot tell", not as 'agent'.
 */
export function resolveEffectiveAgentMode(
  graph: ResolvableGraph | undefined,
  nodeId: string,
): ChatStartMode | undefined {
  const nodes = graph?.nodes;
  if (!nodes) return undefined;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;

  const ownMode = node.config?.mode;
  if (ownMode === 'agent' || ownMode === 'plan' || ownMode === 'debug') return ownMode;

  const startTask = findUpstreamStartTask(nodes, graph?.edges ?? [], nodeId, new Set());
  return startTask ? startModeToChatMode(startTask.config?.startMode) : undefined;
}
