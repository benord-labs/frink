/**
 * Whether a saved flow is complete enough to run, for the agent-facing `frink_flows_run` gate.
 *
 * Flows may be SAVED incomplete so agents can build them incrementally, so completeness is only
 * enforced here, immediately before dispatch. Two checks combine:
 *
 * - `validateGraph` in run mode — the shared, cloud-safe rules.
 * - Required custom-node inputs — deliberately NOT in validateGraph, which also runs server-side
 *   in Frink Cloud and must not depend on desktop filesystem state. Manifest discovery is local to
 *   this process, so the manifest-aware half lives here.
 */

import { isCustomNodeBlockType } from '../../../../shared/lib/block-registry';
import { agentProseGraphErrors } from '../../../../shared/lib/flows/agent-prose-limit';
import {
  findMissingRequiredCustomNodeInputs,
  type JsonValue,
  parseManifestInputDeclarations,
} from '../../../../shared/lib/flows/custom-node-required-inputs';
import {
  type FlowGraph,
  formatFlowNodeLabel,
  validateGraph,
} from '../../../../shared/lib/validate-flow-graph';
import { discoverCustomNodes } from '../../custom-nodes/discovery';

/** Required custom-node inputs the saved graph leaves unset, phrased as run-blocking errors. */
function collectMissingCustomNodeInputErrors(graph: FlowGraph): string[] {
  const nodes = graph.nodes.filter((n) => isCustomNodeBlockType(n.blockType));
  if (nodes.length === 0) return [];
  const inputsByType = new Map(
    // SAFETY: discovery keeps manifest inputs as unparsed JSON; the parser drops anything that is
    // not a well-formed declaration, so nothing downstream trusts the raw shape.
    discoverCustomNodes().valid.map((m) => [
      m.name,
      parseManifestInputDeclarations(m.inputs as JsonValue),
    ]),
  );
  return nodes.flatMap((node) => {
    const missing = findMissingRequiredCustomNodeInputs(
      inputsByType.get(node.blockType),
      // SAFETY: a saved node config is plain JSON by construction — it round-trips through storage.
      node.config as Record<string, JsonValue> | undefined,
    );
    return missing.length === 0
      ? []
      : [
          `Custom node "${formatFlowNodeLabel(node)}" is missing required inputs: ${missing.join(', ')}`,
        ];
  });
}

/**
 * Everything blocking this graph from running, already joined and with the catalog hint appended
 * when the cause is an unresolved webhook selection.
 *
 * @returns null when the flow is ready to run.
 */
export function describeFlowRunBlockers(graph: FlowGraph): string | null {
  const validation = validateGraph(graph, { mode: 'run' });
  const graphErrors = validation.valid ? [] : validation.errors;
  const blockers = [
    ...graphErrors,
    ...agentProseGraphErrors(graph.nodes),
    ...collectMissingCustomNodeInputErrors(graph),
  ];
  if (blockers.length === 0) return null;

  // Classify on the VALIDATOR's own errors, never the combined text: node labels and input names are
  // user-controlled, and a step named after the phrase would otherwise summon an unrelated hint.
  const needsIntegration = graphErrors.some(
    (e) => e.includes('no integration selected') || e.includes('no event type selected'),
  );
  const details = blockers.join('; ');
  return needsIntegration
    ? `${details} — call frink_flows_list_catalog({ kind: 'integrations' }) to resolve integrationId + eventType.`
    : details;
}
