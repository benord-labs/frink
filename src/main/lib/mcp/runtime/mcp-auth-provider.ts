/** Frink as an MCP OAuth client: the SDK's `auth()` drives the protocol, this provider holds the per-consent state (chat-mcp-oauth-client Target). */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { validateOAuthResourceIndicator } from '../../oauth';
import type { FrinkMcpCredentials } from '../types';

/** Frink's Client ID Metadata Document: the URL is the client id at every authorization server that supports it. */
export const FRINK_CLIENT_METADATA_URL = 'https://frink.dev/oauth/client-metadata.json';
const REQUEST_TIMEOUT_MS = 15_000;

/** Every SDK request is bounded — a vendor outage must fail the consent, not leave it pending. */
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** A missing document must degrade to dynamic registration, never mint a client id pointing at a dead URL. */
export async function reachableClientMetadataUrl(
  fetchFn: typeof fetch = timedFetch,
): Promise<string | undefined> {
  const response = await fetchFn(FRINK_CLIENT_METADATA_URL, { method: 'HEAD' }).catch(() => undefined);
  // Only a 200 proves a document is served; a 204 or 3xx would mint a client id nobody can fetch.
  return response?.status === 200 ? FRINK_CLIENT_METADATA_URL : undefined;
}

export type FrinkMcpAuthProviderOptions = {
  /** Exact loopback redirect the listener is already bound on. */
  redirectUrl: string;
  /** A vendor-registered public client (Slack); absent means the SDK registers Frink itself. */
  clientId?: string;
  scope?: string;
  clientMetadataUrl?: string;
  stored?: FrinkMcpCredentials['oauth'];
  state: string;
  onRedirect: (url: URL) => void;
  /** Persist tokens together with the client id they were minted for. */
  onTokens: (tokens: OAuthTokens, clientId: string) => Promise<void>;
};

export class FrinkMcpAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private registered?: OAuthClientInformationMixed;
  private verifier?: string;
  private storedClientUsable = true;
  private storedTokensUsable = true;

  constructor(private readonly opts: FrinkMcpAuthProviderOptions) {
    this.clientMetadataUrl = opts.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    // application_type is a spec MUST for native dynamic registration; the SDK's type omits it but posts the object verbatim.
    const metadata = {
      client_name: 'Frink',
      client_uri: 'https://frink.dev',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
    return metadata as OAuthClientMetadata;
  }

  state(): string {
    return this.opts.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.opts.clientId) return { client_id: this.opts.clientId };
    if (this.registered) return this.registered;
    const stored = this.opts.stored?.clientId;
    return this.storedClientUsable && stored ? { client_id: stored } : undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    if (
      info.client_secret !== undefined &&
      (!('token_endpoint_auth_method' in info) || info.token_endpoint_auth_method !== 'none')
    ) {
      throw new Error('This provider only registers confidential clients; Frink does not store client secrets.');
    }
    // Some public registrations issue an unused secret; retain only the public client identity.
    this.registered = { ...info };
    delete this.registered.client_secret;
    delete this.registered.client_secret_expires_at;
  }

  tokens(): OAuthTokens | undefined {
    const stored = this.opts.stored;
    if (!this.storedTokensUsable || !stored?.accessToken) return undefined;
    return {
      access_token: stored.accessToken,
      token_type: 'bearer',
      ...(stored.scope ? { scope: stored.scope } : {}),
      ...(stored.refreshToken ? { refresh_token: stored.refreshToken } : {}),
      ...(stored.expiresAt !== undefined
        ? { expires_in: Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000)) }
        : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const client = this.clientInformation();
    if (!client) throw new Error('Tokens arrived before any client identity was established.');
    await this.opts.onTokens(tokens, client.client_id);
  }

  redirectToAuthorization(url: URL): void {
    this.opts.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No PKCE verifier exists for this consent.');
    return this.verifier;
  }

  /** Always sends the resource indicator (RFC 8707) — Slack's server requires it even without protected-resource metadata. */
  async validateResourceURL(serverUrl: string | URL): Promise<URL> {
    return new URL(validateOAuthResourceIndicator(String(serverUrl)));
  }

  /** The SDK retries once after invalid_client / invalid_grant; stored material must not be replayed into that retry. */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') {
      this.registered = undefined;
      this.storedClientUsable = false;
    }
    if (scope === 'all' || scope === 'tokens') this.storedTokensUsable = false;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }
}

/** An explicit permission requirement cannot reuse an older or narrower grant. */
export function hasOAuthScopes(oauth: FrinkMcpCredentials['oauth'], required?: string): boolean {
  const granted = new Set(oauth?.scope?.split(/\s+/).filter(Boolean));
  return !required || required.split(/\s+/).filter(Boolean).every((scope) => granted.has(scope));
}
