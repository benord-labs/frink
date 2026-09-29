/**
 * Where an agent / chat_reply node's chat session comes from, for run validation (sc-3836).
 * Uses structural typing so validate-flow-graph can import this without a cycle.
 */

type SessionNode = { id: string; blockType: string; parentId?: string };
type SessionEdge = { source: string; target: string };

// An agent can create its task from a Start Task or continue an upstream agent's session.
export const AGENT_SESSION_SOURCES: ReadonlySet<string> = new Set(['start_task', 'agent']);
export const CHAT_REPLY_SESSION_SOURCES: ReadonlySet<string> = new Set(['start_task']);
export const AFTER_FAN_OUT_NEEDS_OUTER_START =
  'comes after a Fan Out and needs a Start Task outside it — Start Tasks inside a Fan Out only apply to their own item';

/** Every node reachable backwards from `target` (excluding it), in walk order. */
function upstreamNodes(
  nodes: readonly SessionNode[],
  edges: readonly SessionEdge[],
  target: SessionNode,
): SessionNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([target.id]);
  const found: SessionNode[] = [];
  const stack = [target.id];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const edge of edges) {
      const pred = edge.target === id ? byId.get(edge.source) : undefined;
      if (!pred || seen.has(pred.id)) continue;
      seen.add(pred.id);
      found.push(pred);
      stack.push(pred.id);
    }
  }
  return found;
}

/** Walks through lane bodies (a continuation's only inputs are lane tails), but a node outside
 * every Fan Out can't use a lane's source — at runtime that resolves per item. */
export function findUpstreamSession(
  nodes: readonly SessionNode[],
  edges: readonly SessionEdge[],
  target: SessionNode,
  sources: ReadonlySet<string>,
): 'found' | 'lane-only' | 'none' {
  const candidates = upstreamNodes(nodes, edges, target).filter((n) => sources.has(n.blockType));
  if (candidates.some((n) => target.parentId || !n.parentId)) return 'found';
  return candidates.length > 0 ? 'lane-only' : 'none';
}
