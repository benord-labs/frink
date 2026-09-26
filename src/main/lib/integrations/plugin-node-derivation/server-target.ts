/**
 * Resolves a provider_mcp action's server on this machine: the plugin's registered http
 * connector (plugin_<plugin>_<server>) and its chat credential. Call under the plugin lifecycle mutex.
 */
import { catalogFlowHeaders } from '../../../../shared/integrations/catalog';
import { getPluginDefinition } from '../../../../shared/integrations/plugins';
import { vendorPluginMcpServerName } from '../../../../shared/lib/mcp-tool-name';
import { getGlobalMcpServers, getMcpCredentials } from '../../mcp';
import { refreshNearExpiryOAuth } from '../../mcp/runtime/resolve-frink-servers';
import type { FrinkMcpCredentials, FrinkMcpServerConfig } from '../../mcp/types';

type PluginServerTarget = {
  serverName: string;
  config: FrinkMcpServerConfig;
  credentials: FrinkMcpCredentials | undefined;
};

/** Why a node cannot run right now, in the words the user sees. */
type PluginServerRefusal = { ok: false; reason: string };

export type PluginServerResolution = { ok: true; target: PluginServerTarget } | PluginServerRefusal;

function notConnected(pluginId: string): PluginServerRefusal {
  return {
    ok: false,
    reason: `${pluginId} is not connected — connect an account in Settings → Plugins.`,
  };
}

/** The registry entry the plugin owns, structurally: name alone never qualifies, nor does a turned-off one. */
async function readOwnedConfig(
  pluginId: string,
  serverName: string,
  declaredUrl: string,
): Promise<{ ok: true; config: FrinkMcpServerConfig } | PluginServerRefusal> {
  const config = (await getGlobalMcpServers())[serverName];
  // The entry must point at the URL the catalog declares: a bearer never leaves for a tampered host.
  if (!config || config.managedBy !== 'vendor_plugin' || config.url !== declaredUrl) {
    return notConnected(pluginId);
  }
  if (config.enabled === false) {
    return { ok: false, reason: `${pluginId} is turned off — turn it on in Settings → Plugins.` };
  }
  return { ok: true, config };
}

export async function resolvePluginServerTarget(
  pluginId: string,
  serverId: string,
): Promise<PluginServerResolution> {
  const server = getPluginDefinition(pluginId)?.contents.mcpServers.find((s) => s.id === serverId);
  if (!server) return { ok: false, reason: `${pluginId} declares no MCP server "${serverId}".` };
  // Only an http connector is reachable; a catalog-listed command server has no local registration.
  if (server.transport.type !== 'http') return notConnected(pluginId);
  const serverName = vendorPluginMcpServerName(pluginId, serverId);
  if (!serverName) return notConnected(pluginId);
  // Callers hold the plugin's lifecycle mutex, so identity, switch and credential are one snapshot.
  const owned = await readOwnedConfig(pluginId, serverName, server.transport.url);
  if (!owned.ok) return owned;
  const stored = (await getMcpCredentials(serverName)) ?? undefined;
  // A scheduled run has no session start to refresh at; the same coalesced path a chat uses.
  const credentials = await refreshNearExpiryOAuth(serverName, owned.config, stored);
  if (!credentials) return notConnected(pluginId);
  const flowHeaders = catalogFlowHeaders(pluginId, serverId);
  return {
    ok: true,
    target: {
      serverName,
      config: owned.config,
      credentials: flowHeaders
        ? { ...credentials, headers: { ...credentials.headers, ...flowHeaders } }
        : credentials,
    },
  };
}
