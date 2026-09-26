/** The SDK-driven half of a vendor-plugin consent (split out of vendor-plugin-oauth.ts at its size cap). */
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getGlobalMcpServers, getMcpCredentials } from '../config';
import { FrinkMcpAuthProvider, hasOAuthScopes, reachableClientMetadataUrl, timedFetch } from './mcp-auth-provider';
import type { VendorOAuthTarget, VendorPluginConnectResult } from './vendor-plugin-oauth';
import type { LoopbackCallback } from './vendor-plugin-oauth-http';

const CALLBACK_PATH = '/callback';
/** A Disconnect landed mid-consent; like a cancel, this is deliberate — no failure, no alert. */
export const DISCONNECTED = 'Disconnected during authorization.';

/** Slack's vendor registration names `localhost`; a client Frink registers uses the RFC 8252 loopback literal. */
function consentRedirectUrl(target: VendorOAuthTarget, port: number): string {
  const host = target.auth.kind === 'static_client' ? 'localhost' : '127.0.0.1';
  return `http://${host}:${port}${CALLBACK_PATH}`;
}

/** The provider for one consent: static vendor client or Frink's own identity, plus any credential worth renewing. */
async function consentProvider(
  target: VendorOAuthTarget,
  redirectUrl: string,
  state: string,
  hooks: { onRedirect: (url: URL) => void; onTokens: (tokens: OAuthTokens, clientId: string) => Promise<void> },
): Promise<FrinkMcpAuthProvider> {
  const { serverName } = target;
  // Renew only a credential minted for this exact url and client; anything else starts over in the browser.
  const registeredUrl = (await getGlobalMcpServers())[serverName]?.url;
  const candidate = registeredUrl === target.url ? (await getMcpCredentials(serverName))?.oauth : undefined;
  const sameClient = target.auth.kind !== 'static_client' || candidate?.clientId === target.auth.clientId;
  const stored = sameClient && hasOAuthScopes(candidate, target.auth.scope) ? candidate : undefined;
  return new FrinkMcpAuthProvider({
    redirectUrl,
    clientId: target.auth.kind === 'static_client' ? target.auth.clientId : undefined,
    scope: target.auth.scope,
    clientMetadataUrl: target.auth.kind === 'frink_client' ? await reachableClientMetadataUrl() : undefined,
    stored,
    state,
    ...hooks,
  });
}

export type PreparedConsent =
  | { kind: 'authorized'; result: VendorPluginConnectResult }
  | {
      kind: 'redirect';
      authUrl: string;
      cancel: () => void;
      complete: () => Promise<VendorPluginConnectResult>;
    };

type SdkConsentContext = {
  target: VendorOAuthTarget;
  port: number;
  state: string;
  callback: LoopbackCallback;
  authUrl: { promise: Promise<string>; resolve: (value: string) => void };
  /** True once a Disconnect has fenced this consent out. */
  fenced: () => boolean;
  persist: (
    tokens: OAuthTokens,
    clientId: string,
    inheritedRefreshToken: string | undefined,
  ) => Promise<VendorPluginConnectResult>;
};

/** Let the SDK drive: a refreshable credential renews without a browser; otherwise hand back the redirect to present. */
export async function driveSdkConsent(ctx: SdkConsentContext): Promise<PreparedConsent> {
  const { target, port, state, callback, authUrl } = ctx;
  const { serverName } = target;
  let persisted: VendorPluginConnectResult | undefined;
  // Only a silent refresh may inherit the stored refresh token; a fresh code grant stands on its own.
  let refreshing = true;
  const provider = await consentProvider(target, consentRedirectUrl(target, port), state, {
    onRedirect: (url) => authUrl.resolve(url.toString()),
    onTokens: async (tokens, clientId) => {
      const inherited = refreshing ? provider.tokens()?.refresh_token : undefined;
      persisted = await ctx.persist(tokens, clientId, inherited);
    },
  });
  const options = { serverUrl: target.url, scope: target.auth.scope, fetchFn: timedFetch };
  const first = await auth(provider, options);
  // A Disconnect during discovery already closed the listener: never open its browser page.
  if (ctx.fenced()) throw new Error(DISCONNECTED);
  if (first === 'AUTHORIZED') {
    // Nothing will ever await the loopback code: cancelling rejects it on purpose.
    void callback.code.catch(() => {});
    callback.cancel();
    return { kind: 'authorized', result: persisted ?? { serverName } };
  }
  return {
    kind: 'redirect',
    authUrl: await authUrl.promise,
    cancel: callback.cancel,
    complete: async () => {
      const authorizationCode = await callback.code;
      refreshing = false;
      await auth(provider, { ...options, authorizationCode });
      return persisted ?? { serverName };
    },
  };
}

