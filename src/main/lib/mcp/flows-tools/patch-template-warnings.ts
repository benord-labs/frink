/** Template warnings a frink_flows_patch receipt reports, read against the installed nodes. */

import {
  type JsonValue,
  parseManifestInputDeclarations,
} from '../../../../shared/lib/flows/custom-node-required-inputs';
import { manifestOutputsToSchema } from '../../../../shared/lib/output-schemas';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import {
  computeNodeVariables,
  type TemplateVariableWarning,
  validateFlowTemplateVariables,
} from '../../../../shared/lib/validate-flow-templates';
import { discoverCustomNodes } from '../../custom-nodes/discovery';
import { listPluginNodes } from '../../integrations/plugin-node-derivation';

/** Validate a patched graph's templates against each installed node's declared outputs and inputs. */
export function patchTemplateWarnings(graph: FlowGraph): TemplateVariableWarning[] {
  // Plugin nodes are derived, never in `valid`, yet their declared outputs feed {{previous.*}}.
  const { valid } = discoverCustomNodes();
  const customNodeOutputs = new Map(
    [...valid, ...listPluginNodes()].map((m) => [m.name, manifestOutputsToSchema(m.outputs)]),
  );
  const nodeVariables = computeNodeVariables(graph, { customNodeOutputs });
  // Only user nodes carry input declarations; plugin dispatch never reads the template opt-out.
  const customNodeInputs = new Map(
    valid.map((m) => [m.name, parseManifestInputDeclarations(m.inputs as JsonValue)]),
  );
  return validateFlowTemplateVariables(graph, nodeVariables, { customNodeInputs });
}
