/** Template warnings that need no variable schemas: unrendered fields and non-Flow roots. */

import { z } from 'zod';
import { reservedPluginIdForNodeName } from '../../integrations/plugin-nodes';
import { isCustomNodeBlockType } from '../block-registry';
import { TEMPLATE_VARIABLE_PATTERN } from '../template-constants';
import type { FlowNode } from '../validate-flow-graph';
import type { TemplateVariableWarning } from '../validate-flow-templates';
import type {
  CustomNodeInputsByType,
  ManifestInputDeclarations,
} from './custom-node-required-inputs';
import { getTemplateRenderedFields } from './template-rendered-fields';

const CONFIG_STRING = z.string();
const CONFIG_OBJECT = z.record(z.string(), z.unknown());

/** Extract `{{path}}` placeholder paths from a template string. */
export function extractTemplatePaths(template: string): string[] {
  const regex = new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g');
  const paths: string[] = [];
  for (const match of template.matchAll(regex)) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  return paths;
}

/** Roots an author plausibly meant to resolve; loop.* is left out because Jinja owns it too. */
const OPTED_OUT_SUSPECT_ROOTS = new Set(['trigger', 'previous']);

/** In a `"template": false` input, {{trigger.*}}/{{previous.*}} reach the script as literal text. */
function optedOutFlowPlaceholderWarnings(
  nodeId: string,
  field: string,
  paths: string[],
): TemplateVariableWarning[] {
  return paths
    .filter((path) => OPTED_OUT_SUSPECT_ROOTS.has(path.split('.')[0] ?? ''))
    .map((path) => ({
      nodeId,
      field,
      placeholder: `{{${path}}}`,
      message: `{{${path}}} will reach the script as literal text: input "${field}" declares "template": false in its custom node manifest, so no Flow variable in it is resolved.`,
    }));
}

/** Warnings for `{{...}}` in config fields the runtime never renders (e.g. run_command.customPath). */
export function nonRenderedFieldWarnings(
  nodes: FlowNode[],
  customNodeInputs: CustomNodeInputsByType | undefined,
): TemplateVariableWarning[] {
  return nodes.flatMap((node) => nodeFieldWarnings(node, customNodeInputs?.get(node.blockType)));
}

function nodeFieldWarnings(
  node: FlowNode,
  declarations: ManifestInputDeclarations | undefined,
): TemplateVariableWarning[] {
  const config = CONFIG_OBJECT.safeParse(node.config);
  if (!config.success) return [];
  const renderedFields = getTemplateRenderedFields(node.blockType, config.data, declarations);
  return Object.entries(config.data).flatMap(([field, value]) => {
    // Graph JSON is unchecked, so a "string" field can arrive as anything.
    const text = CONFIG_STRING.safeParse(value);
    if (!text.success || renderedFields.includes(field)) return [];
    const paths = extractTemplatePaths(text.data);
    return declarations?.[field]?.template === false
      ? optedOutFlowPlaceholderWarnings(node.id, field, paths)
      : paths.map((path) => unrenderedFieldWarning(node, field, path));
  });
}

function unrenderedFieldWarning(
  node: FlowNode,
  field: string,
  path: string,
): TemplateVariableWarning {
  const note =
    node.blockType === 'run_command' && field === 'customPath'
      ? 'customPath is intentionally not template-rendered (path traversal prevention)'
      : `"${field}" is not template-rendered for ${node.blockType} nodes`;
  return {
    nodeId: node.id,
    field,
    placeholder: `{{${path}}}`,
    message: `Template variable {{${path}}} in config field "${field}" will not be resolved at runtime — ${note}.`,
  };
}

/** A non-Flow root renders empty; only a user node's manifest can opt the input out of rendering. */
export function customNodeNonFlowRootWarning(
  node: FlowNode,
  field: string,
  path: string,
): TemplateVariableWarning | undefined {
  if (!isCustomNodeBlockType(node.blockType)) return undefined;
  const remedy =
    reservedPluginIdForNodeName(node.blockType) === undefined
      ? ` If it is the node script's own template syntax, declare "template": false on input "${field}" in the custom node manifest to pass the value through unrendered.`
      : '';
  return {
    nodeId: node.id,
    field,
    placeholder: `{{${path}}}`,
    message: `{{${path}}} is not a Flow variable and will render as an empty string.${remedy}`,
  };
}
