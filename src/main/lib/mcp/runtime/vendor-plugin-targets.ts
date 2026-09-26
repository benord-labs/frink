import { listStagedVendorPluginMcpServers } from '../../claude/vendor-plugins/mcp-servers';
import { PLUGIN_DEFINITIONS, type PluginMcpAuth } from '../../../../shared/integrations/plugins';
import { vendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import { vendorPluginMcpServerName } from '../../../../shared/lib/mcp-tool-name';

/** The auth kinds the consent can run: a vendor-registered public client, or Frink registering itself. */
type ConsentAuth = Extract<PluginMcpAuth, { kind: 'static_client' | 'frink_client' }>;
type UserTokenAuth = Extract<PluginMcpAuth, { kind: 'user_token' }>;

export type VendorOAuthTarget = {
  serverName: string;
  pluginName: string;
  url: string;
  auth: ConsentAuth;
};
/** A server the user connects by pasting a token (no OAuth path exists, e.g. GitHub). */
export type VendorTokenTarget = Omit<VendorOAuthTarget, 'auth'> & { auth: UserTokenAuth };
export type VendorPluginTarget = VendorOAuthTarget | VendorTokenTarget;

export function isConsentTarget(target: VendorPluginTarget): target is VendorOAuthTarget {
  return target.auth.kind !== 'user_token';
}

function grantAuth(auth: PluginMcpAuth): ConsentAuth | UserTokenAuth | undefined {
  return auth.kind === 'pending' ? undefined : auth;
}

function target(serverName: string, pluginName: string, url: string, auth: ConsentAuth | UserTokenAuth): VendorPluginTarget {
  return auth.kind === 'user_token' ? { serverName, pluginName, url, auth } : { serverName, pluginName, url, auth };
}

/** Frink's declared auth for a staged plugin server, matched by the exact manifest url (the plugin name IS the catalog id). */
function catalogAuth(pluginName: string, url: string): ConsentAuth | UserTokenAuth | undefined {
  const definition = PLUGIN_DEFINITIONS.find((d) => d.id === pluginName);
  for (const { transport } of definition?.contents.mcpServers ?? []) {
    if (transport.type === 'http' && transport.url === url) return grantAuth(transport.auth);
  }
  return undefined;
}

/** Catalog rows without a vendor package declare their servers directly; a Coming soon row carries `pending` and yields nothing. */
function declaredCatalogTargets(): VendorPluginTarget[] {
  return PLUGIN_DEFINITIONS.filter((definition) => !vendorPluginPin(definition.id)).flatMap((definition) =>
    definition.contents.mcpServers.flatMap((server) => {
      const declared = server.transport.type === 'http' ? grantAuth(server.transport.auth) : undefined;
      const serverName = vendorPluginMcpServerName(definition.id, server.id);
      if (!declared || !serverName || server.transport.type !== 'http') return [];
      return [target(serverName, definition.id, server.transport.url, declared)];
    }),
  );
}

/** Every server Frink can run a consent for: staged vendor packages, then catalog rows that declare their own. */
export async function listConnectableVendorPluginMcp(): Promise<VendorPluginTarget[]> {
  const staged = (await listStagedVendorPluginMcpServers()).flatMap((server) => {
    const pluginId = PLUGIN_DEFINITIONS.find(
      (definition) => vendorPluginPin(definition.id)?.name === server.pluginName,
    )?.id;
    if (!pluginId) return [];
    const serverName = vendorPluginMcpServerName(pluginId, server.serverKey);
    const declared = catalogAuth(pluginId, server.url);
    if (!serverName || !declared) return [];
    return [target(serverName, pluginId, server.url, declared)];
  });
  // A staged package outranks the catalog's own declaration of the same server.
  const known = new Set(staged.map((target) => target.serverName));
  return [...staged, ...declaredCatalogTargets().filter((target) => !known.has(target.serverName))];
}
