/** Naming contract for derived plugin nodes: a catalog action id with '.' → '_' is the blockType, so every
 * catalog plugin reserves the `{pluginId}_` node-name namespace (frink-integration-plugin, 2026-08-18 Target). */
import type { ManifestOutputField } from '../lib/output-schemas';
import type { PluginAction } from './plugins';
import { PLUGIN_DEFINITIONS } from './plugins';

/** Node-name grammar under ~/.frink/nodes — shared by discovery and generated plugin nodes. */
export const CUSTOM_NODE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** The generic "call tool" row: a provider_mcp action with no pinned tool — the tool is picked at authoring time. */
export type GenericCallToolAction = Extract<PluginAction, { schemaSource: 'mcp_tools_list' }> & {
  source: { toolId?: undefined };
};

export function isGenericCallToolAction(action: PluginAction): action is GenericCallToolAction {
  return action.source.type === 'provider_mcp' && action.source.toolId === undefined;
}

/** What every MCP-backed plugin node hands the next step; the dispatcher projects the reply to this shape. */
export const MCP_TOOL_NODE_OUTPUTS = {
  text: { type: 'string', description: 'What the tool said, as text' },
  result: { type: 'object', description: 'The full reply: content blocks and any structured data' },
  structured: { type: 'object', description: 'Structured data, when the server sends it' },
} satisfies Readonly<Record<string, ManifestOutputField>>;

/** The outputs a plugin node advertises: a deterministic op's own versioned form, or the MCP reply shape. */
export function pluginActionOutputs(
  action: PluginAction,
): Readonly<Record<string, ManifestOutputField>> | undefined {
  // Variant-only field ('outputs' in action) — nested source.type can't narrow.
  if (action.source.type === 'provider_mcp') return MCP_TOOL_NODE_OUTPUTS;
  return 'outputs' in action ? action.outputs : undefined;
}

/** Fixed inputs of a generic call-tool node; the picked tool's own fields live inside `arguments`. */
export const GENERIC_CALL_TOOL_INPUTS = {
  tool: { type: 'string', required: true, label: 'Tool' },
  arguments: { type: 'json', label: 'Arguments' },
} as const;

/** Node-name namespace a plugin reserves: every node it generates starts with this. */
export function pluginNodeNamePrefix(pluginId: string): string {
  return `${pluginId}_`;
}

/**
 * Folder + manifest name of a catalog action's auto-spawned node ('.' → '_').
 * Throws when the action id cannot form a legal node name.
 */
export function pluginActionNodeName(actionId: string): string {
  const name = actionId.replace(/\./g, '_');
  if (!CUSTOM_NODE_NAME_PATTERN.test(name)) {
    throw new Error(`Plugin action id "${actionId}" cannot form a valid node name ("${name}")`);
  }
  return name;
}

/** Catalog plugin whose reserved node-name namespace contains `nodeName`, if any. */
export function reservedPluginIdForNodeName(nodeName: string): string | undefined {
  return PLUGIN_DEFINITIONS.find((plugin) => nodeName.startsWith(pluginNodeNamePrefix(plugin.id)))
    ?.id;
}

/** Retired machine subfolder of the nodes root (pre-derivation manifests); still reserved so a leftover is reported, never adopted. */
export const INTEGRATION_NODES_SUBDIR = 'integrations';

/** A user node may take neither the retired subfolder's name nor a plugin's node-name namespace. */
export function isReservedNodeName(nodeName: string): boolean {
  return (
    nodeName === INTEGRATION_NODES_SUBDIR || reservedPluginIdForNodeName(nodeName) !== undefined
  );
}

/** Reverse of `pluginActionNodeName` — '.'→'_' is lossy, so resolve against catalog rows. */
export function findPluginActionByNodeName(
  nodeName: string,
): { pluginId: string; action: PluginAction } | undefined {
  for (const definition of PLUGIN_DEFINITIONS) {
    const action = definition.contents.actions.find(
      (row) => pluginActionNodeName(row.id) === nodeName,
    );
    if (action) return { pluginId: definition.id, action };
  }
  return undefined;
}
