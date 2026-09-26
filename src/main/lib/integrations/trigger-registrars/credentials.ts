import { getPluginDefinition } from '../../../../shared/integrations/plugins';
import type { Provider } from '../../../../shared/integrations/types';
import { vendorPluginMcpServerName } from '../../../../shared/lib/mcp-tool-name';
import { decryptToken } from '../../credentials';
import { getGlobalMcpServers, getMcpCredentials } from '../../mcp';
import { refreshNearExpiryOAuth } from '../../mcp/runtime/resolve-frink-servers';
import { VendorRequestError } from './vendor-http';
export type TriggerCredential = 'mcp' | 'api_token';

export async function readToken(
  provider: Provider,
  integration: { api_token_encrypted?: string | null },
  credential: TriggerCredential,
  mcpServerId?: string,
): Promise<string> {
  if (credential === 'api_token') {
    const token = integration.api_token_encrypted
      ? decryptToken(integration.api_token_encrypted)
      : null;
    if (!token)
      throw new VendorRequestError(
        `Add your ${provider.display_name} credential under Set up automatically.`,
        'No trigger API key',
      );
    return token;
  }
  const server = getPluginDefinition(provider.id)?.contents.mcpServers.find(
    (candidate) =>
      candidate.transport.type === 'http' && (!mcpServerId || candidate.id === mcpServerId),
  );
  const name = server ? vendorPluginMcpServerName(provider.id, server.id) : null;
  // The stored chat credential itself (refreshed near expiry), not the node resolver: that one
  // refuses a turned-off plugin, and Remove must still reach the vendor while the plugin is off.
  const config = name ? (await getGlobalMcpServers())[name] : undefined;
  const stored = name ? await getMcpCredentials(name) : undefined;
  const credentials = name && config ? await refreshNearExpiryOAuth(name, config, stored) : stored;
  const token = credentials?.oauth?.accessToken;
  if (!token) {
    throw new VendorRequestError(
      `${provider.display_name} isn't connected — connect it in Settings → Plugins.`,
      'no MCP credential',
    );
  }
  return token;
}
