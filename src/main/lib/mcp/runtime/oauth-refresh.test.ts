import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshOAuthThroughSdk } from './oauth-refresh';

const MCP_URL = 'https://mcp.vendor.test/mcp';
const AS = 'https://auth.vendor.test';
const input = {
  url: MCP_URL,
  oauth: { accessToken: 'old', refreshToken: 'r-old', clientId: 'client-1', expiresAt: Date.now() - 1 },
};

type Recorded = { url: string; body: string };

/** The vendor over global fetch: protected-resource metadata on the MCP host, the authorization server elsewhere. */
function mockVendor(token: (body: string) => Response) {
  const calls: Recorded[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (rawInput, init) => {
    const url = String(rawInput instanceof Request ? rawInput.url : rawInput);
    const body = init?.body === undefined ? '' : String(init.body);
    calls.push({ url, body });
    if (url.startsWith('https://mcp.vendor.test/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: MCP_URL, authorization_servers: [AS] });
    }
    if (url.startsWith(`${AS}/.well-known/`)) {
      return Response.json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url === `${AS}/token`) return token(body);
    return new Response('unexpected', { status: 500 });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('refreshOAuthThroughSdk', () => {
  it('renews through the discovered token endpoint on another host and keeps an unrotated refresh token', async () => {
    const calls = mockVendor(() => Response.json({ access_token: 'new', token_type: 'bearer', expires_in: 60 }));
    await expect(refreshOAuthThroughSdk(input)).resolves.toMatchObject({
      accessToken: 'new',
      refreshToken: 'r-old',
      expiresAt: expect.any(Number),
    });
    const token = calls.find((c) => c.url === `${AS}/token`);
    expect(token?.body).toContain('grant_type=refresh_token');
    expect(token?.body).toContain('client_id=client-1');
    expect(token?.body).not.toContain('client_secret');
  });

  it('takes a rotated refresh token when the vendor issues one', async () => {
    mockVendor(() => Response.json({ access_token: 'new', token_type: 'bearer', refresh_token: 'r-new' }));
    await expect(refreshOAuthThroughSdk(input)).resolves.toMatchObject({ refreshToken: 'r-new', expiresAt: undefined });
  });

  it('never opens a browser or registers a client when the vendor rejects the grant', async () => {
    const calls = mockVendor(() =>
      Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 }),
    );
    await expect(refreshOAuthThroughSdk(input)).rejects.toThrow(/never opens a browser/);
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false);
    expect(calls.some((c) => c.url.startsWith(`${AS}/authorize`))).toBe(false);
  });

  it('surfaces a vendor outage as a failure, leaving the caller to keep the stored credential', async () => {
    mockVendor(() => new Response('down', { status: 503 }));
    await expect(refreshOAuthThroughSdk(input)).rejects.toThrow();
  });
});
