import { describe, expect, it, vi } from 'vitest';
import { FRINK_CLIENT_METADATA_URL, FrinkMcpAuthProvider, reachableClientMetadataUrl } from './mcp-auth-provider';

function provider(overrides: Partial<ConstructorParameters<typeof FrinkMcpAuthProvider>[0]> = {}) {
  return new FrinkMcpAuthProvider({
    redirectUrl: 'http://127.0.0.1:4321/callback',
    state: 'st',
    onRedirect: vi.fn(),
    onTokens: vi.fn(async () => {}),
    ...overrides,
  });
}

describe('FrinkMcpAuthProvider', () => {
  it('prefers a vendor-registered client, then a registration minted this consent, then the stored id', () => {
    expect(provider({ clientId: 'vendor' }).clientInformation()).toEqual({ client_id: 'vendor' });
    const stored = provider({ stored: { accessToken: 'a', clientId: 'stored-1' } });
    expect(stored.clientInformation()).toEqual({ client_id: 'stored-1' });
    stored.saveClientInformation({ client_id: 'dyn', redirect_uris: [] });
    expect(stored.clientInformation()).toEqual({ client_id: 'dyn', redirect_uris: [] });
    expect(provider().clientInformation()).toBeUndefined();
  });

  it('describes Frink as a public native client', () => {
    const p = provider({ scope: 'read' });
    expect(p.clientMetadata).toMatchObject({
      client_name: 'Frink',
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      scope: 'read',
      redirect_uris: ['http://127.0.0.1:4321/callback'],
    });
  });

  it.each([undefined, 'client_secret_basic', 'client_secret_post'])(
    'refuses a secret when the registration auth method is %s',
    (token_endpoint_auth_method) => {
      const p = provider();
      expect(() =>
        p.saveClientInformation({
          client_id: 'c',
          client_secret: 's',
          redirect_uris: [],
          token_endpoint_auth_method,
        }),
      ).toThrow(/client secrets/);
      expect(p.clientInformation()).toBeUndefined();
    },
  );

  it('discards an unused secret from an explicitly public registration', () => {
    const p = provider();
    p.saveClientInformation({
      client_id: 'public',
      client_secret: 'unused',
      client_secret_expires_at: 0,
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    });
    expect(p.clientInformation()).toEqual({
      client_id: 'public',
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    });
  });

  it('maps stored credentials to SDK tokens and persists new ones with the client id they were minted for', async () => {
    const onTokens = vi.fn(async () => {});
    const p = provider({ clientId: 'vendor', stored: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 10_000 }, onTokens });
    expect(p.tokens()).toMatchObject({ access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: expect.any(Number) });
    await p.saveTokens({ access_token: 'n', token_type: 'bearer' });
    expect(onTokens).toHaveBeenCalledWith({ access_token: 'n', token_type: 'bearer' }, 'vendor');
  });

  it('never replays stored tokens or a stored client id into the SDK retry after invalidation', () => {
    const p = provider({ stored: { accessToken: 'a', refreshToken: 'r', clientId: 'stored-1' } });
    p.saveCodeVerifier('v');
    p.invalidateCredentials('all');
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();
    expect(() => p.codeVerifier()).toThrow(/verifier/);
  });

  it('always sends the resource indicator for the MCP server itself', async () => {
    await expect(provider().validateResourceURL('https://mcp.example.com/mcp')).resolves.toEqual(new URL('https://mcp.example.com/mcp'));
  });
});

describe('reachableClientMetadataUrl', () => {
  it('returns the document URL only when it answers 200, degrading to dynamic registration otherwise', async () => {
    await expect(reachableClientMetadataUrl(async () => new Response(null, { status: 200 }))).resolves.toBe(FRINK_CLIENT_METADATA_URL);
    await expect(reachableClientMetadataUrl(async () => new Response(null, { status: 404 }))).resolves.toBeUndefined();
    await expect(reachableClientMetadataUrl(async () => new Response(null, { status: 204 }))).resolves.toBeUndefined();
    await expect(reachableClientMetadataUrl(async () => { throw new Error('offline'); })).resolves.toBeUndefined();
  });
});
