import { PLUGIN_DEFINITIONS } from '../../../../../shared/integrations/plugins';
import { vendorPluginMcpServerName } from '../../../../../shared/lib/mcp-tool-name';

/** One row of the MCP list: the server as the settings UI shows it. */
export type McpServer = {
  name: string;
  config: {
    description?: string;
    authType?: string;
    url?: string;
    requiredEnvVars?: string[];
    enabled?: boolean;
    managedBy?: string;
  };
  status: string;
  tools?: string[];
  error?: string;
};

// Map<status, label> because the keys are snake_case DB enum string values
// (e.g. 'needs_auth'), which violate the renderer's camelCase identifier rule.
const STATUS_TEXT_MAP = new Map<string, string>([
  ['connected', 'Connected'],
  ['disconnected', 'Disconnected'],
  ['needs_auth', 'Needs setup'],
  ['error', 'Error'],
  ['pending', 'Connecting…'],
  ['starting', 'Connecting…'],
]);

export function getStatusText(status: string): string {
  return STATUS_TEXT_MAP.get(status) || status;
}

/** The part of a catalog plugin that names its servers. */
type PluginServers = {
  id: string;
  name: string;
  contents: { mcpServers: ReadonlyArray<{ id: string }> };
};

/** `title` names the row; `name` is the plugin alone. */
type McpOwner = { id: string; name: string; title: string };

/** The plugin that owns an MCP row, or null when it is the user's own server. */
export function pluginMcpOwner(
  serverName: string,
  config: { managedBy?: string },
  plugins: ReadonlyArray<PluginServers> = PLUGIN_DEFINITIONS,
): McpOwner | null {
  if (config.managedBy !== 'vendor_plugin') return null;
  return vendorPluginMcpOwner(serverName, plugins);
}

/** Exact catalog-name lookup for presentation only; a matching name confers no trust. */
export function vendorPluginMcpTitle(
  serverName: string,
  plugins: ReadonlyArray<PluginServers> = PLUGIN_DEFINITIONS,
): string | null {
  return vendorPluginMcpOwner(serverName, plugins)?.title ?? null;
}

function vendorPluginMcpOwner(
  serverName: string,
  plugins: ReadonlyArray<PluginServers>,
): McpOwner | null {
  for (const plugin of plugins) {
    for (const server of plugin.contents.mcpServers) {
      if (vendorPluginMcpServerName(plugin.id, server.id) !== serverName) continue;
      // "PostHog" is what the user installed; a server id only earns a place
      // when one plugin ships several and the name alone stops being unique.
      const title =
        plugin.contents.mcpServers.length > 1 ? `${plugin.name} · ${server.id}` : plugin.name;
      return { id: plugin.id, name: plugin.name, title };
    }
  }
  return null;
}
