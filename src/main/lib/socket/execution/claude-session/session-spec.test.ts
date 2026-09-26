import { describe, expect, it } from 'vitest';
import { buildOAuthServersForConfig } from './session-spec';

const MOCK_OAUTH = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  clientId: 'client-id',
  expiresAt: Date.now() + 3_600_000,
};

describe('buildOAuthServersForConfig', () => {
  it('includes an http server that has _oauth and url', () => {
    const result = buildOAuthServersForConfig({
      'cloudflare-api': {
        type: 'http',
        url: 'https://mcp.cloudflare.com/mcp',
        headers: { Authorization: 'Bearer access-token' },
        _oauth: MOCK_OAUTH,
      },
    });

    expect(result['cloudflare-api']).toMatchObject({
      type: 'http',
      url: 'https://mcp.cloudflare.com/mcp',
      headers: { Authorization: 'Bearer access-token' },
      _oauth: MOCK_OAUTH,
    });
  });

  it('omits a server with no _oauth block (env-var or plain header auth)', () => {
    const result = buildOAuthServersForConfig({
      context7: {
        type: 'http',
        url: 'https://context7.example.com',
        headers: { Authorization: 'Bearer static-key' },
      },
    });

    expect(result.context7).toBeUndefined();
  });

  it('omits a server that has no url', () => {
    const result = buildOAuthServersForConfig({
      broken: { type: 'http', _oauth: MOCK_OAUTH },
    });

    expect(result.broken).toBeUndefined();
  });

  it('omits a stdio server (type !== http)', () => {
    const result = buildOAuthServersForConfig({
      'my-mcp': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'my-mcp'],
        _oauth: MOCK_OAUTH,
      },
    });

    expect(result['my-mcp']).toBeUndefined();
  });

  it('includes a server typed as sse and preserves its transport type', () => {
    const result = buildOAuthServersForConfig({
      'sse-mcp': { type: 'sse', url: 'https://example.com/sse', _oauth: MOCK_OAUTH },
    });

    expect(result['sse-mcp']).toMatchObject({ type: 'sse', url: 'https://example.com/sse' });
  });

  it('omits headers key when no headers are present on the config', () => {
    const result = buildOAuthServersForConfig({
      'no-headers': { type: 'http', url: 'https://example.com/mcp', _oauth: MOCK_OAUTH },
    });

    expect(result['no-headers']).not.toHaveProperty('headers');
  });

  it('returns empty map for an empty input (no file should be written)', () => {
    expect(buildOAuthServersForConfig({})).toEqual({});
  });

  it('returns empty map when no server has _oauth', () => {
    const result = buildOAuthServersForConfig({
      github: { type: 'http', url: 'https://api.github.com' },
    });

    expect(Object.keys(result)).toHaveLength(0);
  });

  it('includes multiple oauth servers and excludes non-oauth ones', () => {
    const result = buildOAuthServersForConfig({
      'cloudflare-api': {
        type: 'http',
        url: 'https://mcp.cloudflare.com/mcp',
        headers: { Authorization: 'Bearer cf-token' },
        _oauth: MOCK_OAUTH,
      },
      github: {
        type: 'http',
        url: 'https://github.example.com',
        headers: { Authorization: 'Bearer static' },
      },
      notion: {
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        _oauth: { ...MOCK_OAUTH, accessToken: 'notion-token' },
      },
    });

    expect(Object.keys(result).sort()).toEqual(['cloudflare-api', 'notion']);
    expect((result.notion as Record<string, unknown>)._oauth).toMatchObject({
      accessToken: 'notion-token',
    });
  });
});
