/** The one persisted piece of an integration node: the tool schema probed on connect / Turn on. A failed
 * probe keeps the previous row — a connect-time timeout must never read as "this plugin has no tools". */
import { type JsonNode, selectMcpPresetSchema } from '../../../../shared/lib/flows/mcp-tool-preset';
import { getPluginDefinition } from '../../../../shared/integrations';
import { jsonSchemaToManifestInputs } from '../../../../shared/lib/flows/json-schema-to-manifest-inputs';
import { getDatabase } from '../../db';
import { listPluginNodeSchemas, upsertPluginNodeSchema } from '../../db/repos/plugin-node-schemas';
import {
  fetchMcpToolDescriptors,
  fetchMcpToolDescriptorsStdio,
  type McpToolDescriptor,
} from '../../mcp/tools-probe';
import { captureMainMessage } from '../../sentry/init';
import { listConnectedPluginIds } from './index';
import { resolvePluginServerTarget } from './server-target';

type DescriptorFetch =
  | { ok: true; byTool: Map<string, McpToolDescriptor> }
  | { ok: false; reason: string };

/** Fetch live descriptors for one of the plugin's servers; a typed failure, never an empty list. */
export async function fetchServerDescriptors(
  pluginId: string,
  serverId: string,
): Promise<DescriptorFetch> {
  const resolved = await resolvePluginServerTarget(pluginId, serverId);
  if (!resolved.ok) return resolved;
  const { config, credentials, serverName } = resolved.target;
  const result = config.url
    ? await fetchMcpToolDescriptors(config.url, credentials?.headers, serverName)
    : await fetchMcpToolDescriptorsStdio(
        {
          command: config.command,
          args: config.args,
          env: credentials?.env,
        },
        serverName,
      );
  if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.message}` };
  return { ok: true, byTool: new Map(result.tools.map((t) => [t.name, t])) };
}

const inFlight = new Map<string, Promise<void>>();

/** Re-probe every pinned curated action of one plugin and cache what the server advertises. Probes for one plugin run in call order, so a slow earlier probe never overwrites a later one. */
export function refreshPluginNodeSchemas(pluginId: string): Promise<void> {
  const previous = inFlight.get(pluginId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => probeAndCache(pluginId));
  inFlight.set(pluginId, run);
  return run.finally(() => {
    if (inFlight.get(pluginId) === run) inFlight.delete(pluginId);
  });
}

/** The probe as every lifecycle step calls it. A cold or stale schema degrades one node's form, never the
 * plugin (frink-integration-plugin 2026-09-07): a thrown probe is a warning, not a failed connect or Turn on. */
export async function probeSchemasBestEffort(pluginId: string): Promise<void> {
  try {
    await refreshPluginNodeSchemas(pluginId);
  } catch (error) {
    captureMainMessage(`Plugin node schema probe failed: ${String(error)}`, 'warning', {
      surface: 'plugin-node-schema-cache',
      pluginId,
    });
  }
}

/** New catalog actions also need fields for accounts connected before this app update. */
export async function refreshMissingPluginNodeSchemas(): Promise<void> {
  const db = getDatabase();
  await Promise.all(
    [...listConnectedPluginIds()].map(async (pluginId) => {
      const definition = getPluginDefinition(pluginId);
      const cached = listPluginNodeSchemas(db, pluginId);
      const missing = definition?.contents.actions.some(
        ({ id, source }) =>
          source.type === 'provider_mcp' &&
          source.toolId &&
          !cached.has(id) &&
          definition.contents.mcpServers.some(
            (server) => server.id === source.serverId && server.transport.type === 'http',
          ),
      );
      if (missing) await probeSchemasBestEffort(pluginId);
    }),
  );
}

async function probeAndCache(pluginId: string): Promise<void> {
  const actions = getPluginDefinition(pluginId)?.contents.actions ?? [];
  const pinned = actions.flatMap((action) =>
    action.source.type === 'provider_mcp' && action.source.toolId !== undefined
      ? [
          {
            actionId: action.id,
            serverId: action.source.serverId,
            toolId: action.source.toolId,
            preset: action.source.preset,
          },
        ]
      : [],
  );
  const serverIds = [...new Set(pinned.map((row) => row.serverId))];
  const fetched = await Promise.all(
    serverIds.map((serverId) => fetchServerDescriptors(pluginId, serverId)),
  );
  const byServer = new Map(serverIds.map((serverId, i) => [serverId, fetched[i]]));
  for (const result of fetched) {
    if (!result.ok) {
      captureMainMessage(`Plugin node schema probe failed (${result.reason})`, 'warning', {
        surface: 'plugin-node-schema-cache',
        pluginId,
      });
    }
  }
  const db = getDatabase();
  for (const { actionId, serverId, toolId, preset } of pinned) {
    const result = byServer.get(serverId);
    const descriptor = result?.ok ? result.byTool.get(toolId) : undefined;
    if (!descriptor) continue;
    const selected = preset
      ? // SAFETY: a tool descriptor's input schema is the JSON the server sent for tools/list.
        selectMcpPresetSchema((descriptor.inputSchema ?? null) as JsonNode, preset)
      : { ok: true as const, schema: descriptor.inputSchema ?? {} };
    if (!selected.ok) {
      captureMainMessage(`Plugin node schema selection failed: ${selected.reason}`, 'warning', {
        surface: 'plugin-node-schema-cache',
        pluginId,
        actionId,
      });
      continue;
    }
    upsertPluginNodeSchema(db, {
      pluginId,
      actionId,
      ...jsonSchemaToManifestInputs(selected.schema),
    });
  }
}
