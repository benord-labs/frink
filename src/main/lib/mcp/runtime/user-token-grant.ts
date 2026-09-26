/** Token grant for a plugin server with no OAuth path: validate the pasted token against the vendor, then store it as the bearer. */
import { TRPCError } from '@trpc/server';
import {
  isConsentTarget,
  listConnectableVendorPluginMcp,
  persistUserToken,
  type VendorTokenTarget,
} from './vendor-plugin-oauth';

const VALIDATION_TIMEOUT_MS = 15_000;

/** The manifest schema pins a token-granted plugin to one server, so the grant is one validation and one write. */
async function tokenTarget(pluginName: string): Promise<VendorTokenTarget | undefined> {
  return (await listConnectableVendorPluginMcp()).find(
    (target): target is VendorTokenTarget => target.pluginName === pluginName && !isConsentTarget(target),
  );
}

/** Connects the plugin's token server, or throws with the vendor's verdict so the page can say why. */
export async function connectUserTokenMcp(
  pluginName: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const target = await tokenTarget(pluginName);
  if (!target) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This plugin does not take a token.' });
  }
  const response = await fetchFn(target.auth.validation.url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The token was rejected (HTTP ${response.status}). Create a new one and paste it again.`,
    });
  }
  await persistUserToken(target, token);
  return [target.serverName];
}
