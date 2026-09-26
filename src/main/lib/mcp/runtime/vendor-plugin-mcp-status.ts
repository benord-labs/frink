/** Delivery status for plugin tools, and stored grant ownership for installation lifetime. */
import { getGlobalMcpServers, readMcpCredentials } from '../config';
import { hasOAuthScopes } from './mcp-auth-provider';
import { usableOrRefreshableOAuth } from './resolve-frink-servers';
import {
  getVendorPluginMcpConsentOutcome,
  getVendorPluginMcpConsentUrl,
  listConnectableVendorPluginMcp,
  ownedVendorPluginServerNames,
} from './vendor-plugin-oauth';

type VendorMcpRef = { serverName: string; pluginName: string };

/** Staged plugin MCP servers and whether each holds a usable credential — read from the store delivery reads. */
export async function vendorPluginMcpStatus(): Promise<{
  connected: VendorMcpRef[];
  awaitingAuth: (VendorMcpRef & { lastError?: string; consentUrl?: string })[];
}> {
  const registered = await getGlobalMcpServers();
  // One credentials snapshot for the whole sweep — a per-target read re-decrypts the file each time.
  const credentials = (await readMcpCredentials()).servers;
  const connected: VendorMcpRef[] = [];
  const awaitingAuth: (VendorMcpRef & { lastError?: string; consentUrl?: string })[] = [];
  for (const target of await listConnectableVendorPluginMcp()) {
    const ref = { serverName: target.serverName, pluginName: target.pluginName };
    const credential = registered[target.serverName] ? credentials[target.serverName] : undefined;
    // A token server is connected by its stored bearer; an OAuth server by a usable or refreshable grant.
    const tokenConnected =
      target.auth.kind === 'user_token' && Boolean(credential?.headers?.Authorization);
    if (tokenConnected || (target.auth.kind !== 'user_token' && hasOAuthScopes(credential?.oauth, target.auth.scope) && usableOrRefreshableOAuth(credential))) {
      connected.push(ref);
    } else {
      const lastError = getVendorPluginMcpConsentOutcome(target.serverName)?.error;
      const consentUrl = getVendorPluginMcpConsentUrl(target.serverName);
      awaitingAuth.push({ ...ref, ...(lastError && { lastError }), ...(consentUrl && { consentUrl }) });
    }
  }
  return { connected, awaitingAuth };
}

/** A stored grant keeps the installation even while its package is missing, upgraded, or needs reauthorization. */
export async function hasStoredVendorPluginMcpCredential(pluginName: string): Promise<boolean> {
  const credentials = (await readMcpCredentials()).servers;
  for (const serverName of await ownedVendorPluginServerNames(pluginName)) {
    const credential = credentials[serverName];
    if (credential?.oauth?.accessToken || credential?.headers?.Authorization) return true;
  }
  return false;
}
