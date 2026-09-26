/**
 * Projections of the installed custom-node list into the lookup maps the flow editor renders from.
 *
 * One list, several consumers: the canvas needs icons, the variable picker needs output schemas, and
 * the rehearsal needs declared inputs. Building them here keeps FlowEditor to wiring.
 */

import {
  type CustomNodeInputsByType,
  type JsonValue,
  parseManifestInputDeclarations,
} from '../../../shared/lib/flows/custom-node-required-inputs';
import {
  type ManifestOutputField,
  manifestOutputsToSchema,
  type OutputFieldSchema,
} from '../../../shared/lib/output-schemas';

/** The slice of an installed custom node these projections read. */
export type CustomNodeSummary = {
  name: string;
  icon?: string | null;
  inputs?: JsonValue;
  outputs?: Record<string, ManifestOutputField>;
};

/** Declared output fields per node, omitting nodes that declare none. */
export function buildCustomNodeOutputsMap(
  customNodes: CustomNodeSummary[] | undefined,
): Map<string, OutputFieldSchema[]> {
  const m = new Map<string, OutputFieldSchema[]>();
  if (!customNodes) return m;
  for (const n of customNodes) {
    const fields = manifestOutputsToSchema(n.outputs);
    if (fields.length > 0) m.set(n.name, fields);
  }
  return m;
}

/** Lucide icon key per node, omitting nodes that declare none. */
export function buildCustomNodeBlockIconsMap(
  customNodes: CustomNodeSummary[] | undefined,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!customNodes) return m;
  for (const n of customNodes) {
    const icon = n.icon?.trim();
    if (icon) m.set(n.name, icon);
  }
  return m;
}

/**
 * Declared inputs per node, for the rehearsal's required-input check.
 *
 * Returns undefined while the node list is unknown, which the analyzer reads as "not discovered
 * yet" rather than "nothing is required" — the distinction that stops a healthy node being flagged.
 */
export function buildCustomNodeInputsMap(
  customNodes: CustomNodeSummary[] | undefined,
): CustomNodeInputsByType | undefined {
  return (
    customNodes &&
    new Map(customNodes.map((n) => [n.name, parseManifestInputDeclarations(n.inputs ?? {})]))
  );
}
