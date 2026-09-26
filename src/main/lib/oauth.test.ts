import { describe, expect, it } from 'vitest';
import { CraftOAuth, getMcpBaseUrl, validateOAuthResourceIndicator } from './oauth';

describe('getMcpBaseUrl', () => {
  it('strips /mcp suffix', () => {
    expect(getMcpBaseUrl('https://mcp.cloudflare.com/mcp')).toBe('https://mcp.cloudflare.com');
  });

  it('strips /sse suffix', () => {
    expect(getMcpBaseUrl('https://example.com/sse')).toBe('https://example.com');
  });

  it('strips /mcp with trailing slash', () => {
    // Before fix: getMcpBaseUrl left a trailing slash → .well-known URL became double-slash
    expect(getMcpBaseUrl('https://mcp.cloudflare.com/mcp/')).toBe('https://mcp.cloudflare.com');
  });

  it('strips /sse with trailing slash', () => {
    expect(getMcpBaseUrl('https://example.com/sse/')).toBe('https://example.com');
  });

  it('strips a bare trailing slash when no mcp/sse suffix', () => {
    expect(getMcpBaseUrl('https://example.com/')).toBe('https://example.com');
  });

  it('leaves a clean URL unchanged', () => {
    expect(getMcpBaseUrl('https://example.com')).toBe('https://example.com');
  });

  it('does not strip mcp from a domain name', () => {
    // "mcp" in the domain must survive; only the path suffix is removed
    expect(getMcpBaseUrl('https://mcp.cloudflare.com')).toBe('https://mcp.cloudflare.com');
  });

  it('strips /mcp from a multi-segment path', () => {
    expect(getMcpBaseUrl('https://example.com/api/mcp')).toBe('https://example.com/api');
  });

  it('result is safe to append /.well-known/... without double slash', () => {
    const base = getMcpBaseUrl('https://mcp.cloudflare.com/mcp');
    expect(`${base}/.well-known/oauth-authorization-server`).toBe(
      'https://mcp.cloudflare.com/.well-known/oauth-authorization-server',
    );
  });
});

describe('validateOAuthResourceIndicator', () => {
  it('accepts absolute https URL and returns canonical href', () => {
    expect(validateOAuthResourceIndicator('https://mcp.example.com/mcp')).toBe(
      'https://mcp.example.com/mcp',
    );
  });

  it('rejects empty and whitespace', () => {
    expect(() => validateOAuthResourceIndicator('')).toThrow(/non-empty absolute URI/);
    expect(() => validateOAuthResourceIndicator('   ')).toThrow(/non-empty absolute URI/);
  });

  it('rejects relative URLs', () => {
    expect(() => validateOAuthResourceIndicator('/only/a/path')).toThrow(/valid absolute URI/);
  });

  it('rejects fragment', () => {
    expect(() => validateOAuthResourceIndicator('https://mcp.example.com/mcp#sect')).toThrow(
      /fragment/,
    );
  });
});

describe('CraftOAuth constructor (resource)', () => {
  const noop = { onStatus: () => {}, onError: () => {} };
  const base = { mcpBaseUrl: 'https://mcp.example.com/mcp' };

  it('throws when resource is not an absolute URI', () => {
    expect(() => new CraftOAuth({ ...base, resource: '/relative-only' }, noop)).toThrow(
      /absolute URI/,
    );
  });

  it('throws when resource includes a fragment', () => {
    expect(
      () => new CraftOAuth({ ...base, resource: 'https://resource.example/mcp#frag' }, noop),
    ).toThrow(/fragment/);
  });

  it('accepts omitting resource', () => {
    expect(() => new CraftOAuth(base, noop)).not.toThrow();
  });
});
