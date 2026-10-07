/** Integration Flow nodes, derived at read time (frink-integration-plugin 2026-09-07): connection state ×
 * catalog actions, never written to disk; only the probed tool schema persists (schema-cache.ts). */
import {
  GENERIC_CALL_TOOL_INPUTS,
  isGenericCallToolAction,
  pluginActionNodeName,
  pluginActionOutputs,
} from '../../../../shared/integrations/plugin-nodes';
import {
  getPluginDefinition,
  PLUGIN_DEFINITIONS,
  type PluginAction,
  type PluginActionInput,
} from '../../../../shared/integrations/plugins';
import type { CustomNodeIconKey } from '../../../../shared/lib/custom-node-icon-allowlist';
import type { ManifestInputProjection } from '../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import { vendorPluginMcpServerName } from '../../../../shared/lib/mcp-tool-name';
import type { ManifestOutputField } from '../../../../shared/lib/output-schemas';
import { getDatabase } from '../../db';
import {
  listPluginNodeSchemasByPlugin,
  type PluginNodeSchema,
} from '../../db/repos/plugin-node-schemas';
import { readMcpConfigSync } from '../../mcp';

const PLUGIN_NODE_VERSION = '1';
const PLUGIN_NODE_TIMEOUT_SECONDS = 60;

type PluginNodeKind = 'plugin_mcp_tool' | 'plugin_operation';

/** A probed provider field, or a deterministic op's own versioned field. */
type PluginNodeInput = ManifestInputProjection | PluginActionInput;

/** What shapes a node's form and its dispatch preflight. */
export type PluginNodeFields = {
  inputs: Record<string, PluginNodeInput>;
  unsupportedFields: string[];
};

export type PluginNodeManifest = PluginNodeFields & {
  name: string;
  displayName: string;
  description: string;
  version: string;
  timeout: number;
  kind: PluginNodeKind;
  /** Catalog action the node stands for. */
  owner: { pluginId: string; actionId: string };
  source: PluginAction['source'];
  outputs?: Record<string, ManifestOutputField>;
  icon?: CustomNodeIconKey;
};

/** Plugins whose nodes exist right now, from the evidence dispatch uses. Lock-free: a read racing a
 * lifecycle change may show a stale row for one refetch, which dispatch then refuses. */
export function listConnectedPluginIds(): Set<string> {
  const connected = new Set<string>();
  const servers = readMcpConfigSync().servers;
  // Plugins ride the TOOLS grant: the registered, enabled vendor server is the connection, whatever
  // accounts exist (no credential check — the picker and dispatch stay credential-gated).
  for (const definition of PLUGIN_DEFINITIONS) {
    const live = definition.contents.mcpServers.some((server) => {
      if (server.transport.type !== 'http') return false;
      const name = vendorPluginMcpServerName(definition.id, server.id);
      const config = name ? servers[name] : undefined;
      return config?.managedBy === 'vendor_plugin' && config.enabled !== false;
    });
    if (live) connected.add(definition.id);
  }
  return connected;
}

/** A node's fields: the generic call-tool row and a deterministic op carry their own; a pinned provider
 * tool needs its probed schema and is omitted until one is cached (Turn off → on re-probes). */
export function pluginNodeFields(
  action: PluginAction,
  cached: ReadonlyMap<string, PluginNodeSchema>,
): PluginNodeFields | undefined {
  if (isGenericCallToolAction(action)) {
    return { inputs: { ...GENERIC_CALL_TOOL_INPUTS }, unsupportedFields: [] };
  }
  if (action.source.type === 'provider_mcp') return cached.get(action.id);
  // Nested source.type does not narrow the union; the variant-only `inputs` field does.
  return 'inputs' in action ? { inputs: { ...action.inputs }, unsupportedFields: [] } : undefined;
}

function manifestFor(action: PluginAction, fields: PluginNodeFields): PluginNodeManifest {
  const manifest: PluginNodeManifest = {
    name: pluginActionNodeName(action.id),
    displayName: action.label,
    description: action.description ?? '',
    version: PLUGIN_NODE_VERSION,
    timeout: PLUGIN_NODE_TIMEOUT_SECONDS,
    kind: action.source.type === 'provider_mcp' ? 'plugin_mcp_tool' : 'plugin_operation',
    owner: { pluginId: action.id.split('.')[0], actionId: action.id },
    source: action.source,
    ...fields,
  };
  const outputs = pluginActionOutputs(action);
  if (outputs) manifest.outputs = { ...outputs };
  if (action.icon) manifest.icon = action.icon;
  return manifest;
}

/** Every integration node on this machine, or one plugin's. Uncached on purpose: staleness is the bug class this replaces. */
export function listPluginNodes(pluginId?: string): PluginNodeManifest[] {
  const ids = [...listConnectedPluginIds()].filter(
    (id) =>
      (pluginId === undefined || id === pluginId) &&
      (getPluginDefinition(id)?.contents.actions.length ?? 0) > 0,
  );
  // One query for every plugin, not one per plugin: readiness and the palette call this per request.
  const cachedByPlugin = listPluginNodeSchemasByPlugin(getDatabase(), ids);
  const nodes: PluginNodeManifest[] = [];
  for (const id of ids) {
    const actions = getPluginDefinition(id)?.contents.actions ?? [];
    const cached = cachedByPlugin.get(id) ?? new Map<string, PluginNodeSchema>();
    for (const action of actions) {
      const fields = pluginNodeFields(action, cached);
      if (fields) nodes.push(manifestFor(action, fields));
    }
  }
  return nodes;
}
