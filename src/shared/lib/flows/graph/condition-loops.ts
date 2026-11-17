/**
 * Condition-loop rules for Flow graph validation: stuck condition-only loops and `loop` config.
 */

import { z } from 'zod';
import { findCyclicComponents } from '../../flow-graph-cycle';
import type { FlowEdge, FlowNode } from '../../validate-flow-graph';

const loopConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(50),
  onMaxReached: z.enum(['fail', 'continue']).optional(),
});

/**
 * Loops made only of condition nodes. Nothing in one does work, so each pass re-checks the same
 * passthrough data and the loop can run forever. Members are in `nodes` order.
 */
function findStuckConditionLoops(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[][] {
  const conditions = nodes.filter((n) => n.blockType === 'condition');
  const conditionIds = new Set(conditions.map((n) => n.id));
  const byId = new Map(conditions.map((n) => [n.id, n]));
  const conditionEdges = edges.filter(
    (e) => conditionIds.has(e.source) && conditionIds.has(e.target),
  );
  return findCyclicComponents({ nodes: conditions, edges: conditionEdges }).map((ids) =>
    ids.flatMap((id) => byId.get(id) ?? []),
  );
}

function describeStuckConditionLoop(labels: string[]): string {
  const names = labels.map((label) => `"${label}"`);
  if (names.length === 1) {
    return `Condition ${names[0]} loops back to itself with no step in between, so it can loop forever — add a step inside the loop`;
  }
  return `Condition-only loop ${names.join(' → ')} has no step inside it, so it can loop forever — add a step inside the loop`;
}

/** Stuck condition-only loops: the ids of every node in one, and one message per loop. */
export type StuckConditionLoops = { nodeIds: Set<string>; messages: string[] };

/** Finds stuck condition-only loops and words them with `label` for each node. */
export function stuckConditionLoops(
  nodes: FlowNode[],
  edges: FlowEdge[],
  label: (n: FlowNode) => string,
): StuckConditionLoops {
  const loops = findStuckConditionLoops(nodes, edges);
  return {
    nodeIds: new Set(loops.flatMap((loop) => loop.map((n) => n.id))),
    messages: loops.map((loop) => describeStuckConditionLoop(loop.map(label))),
  };
}

/** Errors for a condition node's optional `loop` config (`name` is its display label). */
export function conditionLoopConfigErrors(name: string, config: FlowNode['config']): string[] {
  const loop = config?.loop;
  if (loop === undefined) return [];
  const parsed = loopConfigSchema.safeParse(loop);
  if (parsed.success) return [];
  const issues = parsed.error.issues;
  if (issues.some((issue) => issue.path.length === 0)) {
    return [`Condition node "${name}" loop config must be an object`];
  }
  const badFields = new Set(issues.map((issue) => issue.path[0]));
  const errors: string[] = [];
  if (badFields.has('maxIterations')) {
    errors.push(`Condition node "${name}" loop.maxIterations must be an integer between 1 and 50`);
  }
  if (badFields.has('onMaxReached')) {
    errors.push(`Condition node "${name}" loop.onMaxReached must be "fail" or "continue"`);
  }
  return errors;
}
