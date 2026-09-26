/**
 * Loop metadata for back-edges, shared by the interactive canvas and the read-only preview.
 *
 * `FlowNode.config` is an untyped `Record<string, unknown>` (see validate-flow-graph), so
 * reading `loop.maxIterations` needs a runtime shape check rather than a cast.
 */

import type { FlowNode } from '../../../shared/lib/validate-flow-graph';

/** The iteration cap a back-edge should label, or undefined when the node declares none. */
export function backEdgeLoopMaxIterations(node: FlowNode | undefined): number | undefined {
  const loopCfg = node?.config?.loop;
  if (
    loopCfg == null ||
    typeof loopCfg !== 'object' ||
    Array.isArray(loopCfg) ||
    typeof (loopCfg as Record<string, unknown>).maxIterations !== 'number'
  ) {
    return undefined;
  }
  return (loopCfg as Record<string, unknown>).maxIterations as number;
}
