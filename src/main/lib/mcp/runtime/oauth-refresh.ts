/** Session-start token refresh through the MCP SDK: the same provider as consent, but no browser can ever open. */
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { FrinkMcpAuthProvider, timedFetch } from './mcp-auth-provider';

export type RefreshInput = {
  url: string;
  oauth: { accessToken: string; refreshToken: string; clientId: string; expiresAt?: number; scope?: string };
};

export type RefreshedTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };

const REFRESH_ONLY = 'Session-start refresh never opens a browser; reconnect is required.';

/** Renew a stored credential: the stored client id is pinned (no re-registration) and the SDK's authorize fallback throws instead of opening a browser. */
export async function refreshOAuthThroughSdk(input: RefreshInput): Promise<RefreshedTokens> {
  let refreshed: OAuthTokens | undefined;
  const provider = new FrinkMcpAuthProvider({
    redirectUrl: 'http://127.0.0.1/callback',
    clientId: input.oauth.clientId,
    stored: input.oauth,
    state: '',
    onRedirect: () => {
      throw new Error(REFRESH_ONLY);
    },
    onTokens: async (tokens) => {
      refreshed = tokens;
    },
  });
  const result = await auth(provider, { serverUrl: input.url, fetchFn: timedFetch });
  if (result !== 'AUTHORIZED' || !refreshed) throw new Error(REFRESH_ONLY);
  return {
    accessToken: refreshed.access_token,
    scope: refreshed.scope ?? input.oauth.scope,
    // A refresh that rotates nothing keeps the stored refresh token (RFC 6749 §6).
    refreshToken: refreshed.refresh_token ?? input.oauth.refreshToken,
    expiresAt: refreshed.expires_in !== undefined ? Date.now() + refreshed.expires_in * 1000 : undefined,
  };
}
