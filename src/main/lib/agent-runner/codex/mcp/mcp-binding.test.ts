import { describe, expect, it } from 'vitest';
import { buildCodexMcpBinding } from './mcp-binding';

describe('buildCodexMcpBinding', () => {
  it('replaces native MCPs and scopes an OAuth credential to its Frink remote', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        shortcut: {
          type: 'http',
          url: 'https://mcp.example.test',
          _oauth: { accessToken: 'frink-secret' },
        },
      },
    });

    expect(binding.threadConfig).toEqual({
      mcp_oauth_credentials_store: 'file',
      mcp_servers: {
        __frink_replace: true,
        shortcut: {
          enabled: true,
          url: 'https://mcp.example.test',
          http_headers: { Authorization: 'Bearer frink-secret' },
        },
      },
    });
    expect(binding).not.toHaveProperty('env');
  });

  it('keeps the Flow MCP inside the replacement table', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        frink_dynamic_chat: { url: 'http://127.0.0.1:4312/mcp?channel=chat' },
      },
    });

    expect(binding.threadConfig.mcp_servers).toEqual({
      __frink_replace: true,
      frink_dynamic_chat: {
        enabled: true,
        url: 'http://127.0.0.1:4312/mcp?channel=chat',
      },
    });
  });

  it('installs Frink task completion as a native Codex Stop hook', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        frink_dynamic_chat: { url: 'http://127.0.0.1:4312/mcp?channel=chat' },
      },
      taskSignalEnabled: true,
    });

    expect(binding.threadConfig.hooks).toEqual({
      Stop: [
        {
          hooks: [
            {
              type: 'mcp_tool',
              server: 'frink_dynamic_chat',
              tool: 'frink_task_stop_guard',
              input: { stop_hook_active: `\${stop_hook_active}` },
              timeout: 5,
            },
          ],
        },
      ],
    });
  });

  it('preserves non-empty headers and omits empty values', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        remote: {
          url: 'https://mcp.example.test',
          headers: { 'X-API-Key': 'key', Empty: '  ' },
        },
      },
    });

    expect(binding.threadConfig.mcp_servers).toMatchObject({
      remote: { http_headers: { 'X-API-Key': 'key' } },
    });
  });

  it('preserves a non-Bearer Authorization header', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        remote: {
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Basic abc123' },
        },
      },
    });

    expect(binding.threadConfig.mcp_servers).toMatchObject({
      remote: { http_headers: { Authorization: 'Basic abc123' } },
    });
  });

  it('rejects conflicting OAuth and Authorization credentials', () => {
    expect(() =>
      buildCodexMcpBinding({
        canonicalServers: {
          remote: {
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer header-token' },
            _oauth: { accessToken: 'oauth-token' },
          },
        },
      }),
    ).toThrow('conflicting OAuth and Authorization credentials');
  });

  it('projects an expired OAuth credential so only that server fails, not the turn', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: {
        vercel: {
          url: 'https://mcp.example.test',
          _oauth: { accessToken: 'stale', expiresAt: Date.now() - 60_000 },
        },
      },
    });

    expect(binding.threadConfig.mcp_servers).toMatchObject({
      vercel: { http_headers: { Authorization: 'Bearer stale' } },
    });
  });

  it('scopes stdio credentials to the Frink MCP definition', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: { railway: { command: 'npx', args: ['railway-mcp'] } },
      envByServer: { railway: { RAILWAY_TOKEN: 'secret' } },
    });

    expect(binding.threadConfig.mcp_servers).toMatchObject({
      railway: {
        enabled: true,
        command: 'npx',
        args: ['railway-mcp'],
        env: { RAILWAY_TOKEN: 'secret' },
      },
    });
  });

  it('removes the Claude-only ordering prefix from scoped package names', () => {
    const binding = buildCodexMcpBinding({
      canonicalServers: { 'z_@scope/server': { command: 'npx', args: ['@scope/server'] } },
    });

    expect(binding.threadConfig.mcp_servers).toMatchObject({
      '@scope/server': { enabled: true, command: 'npx', args: ['@scope/server'] },
    });
  });

  it('changes the unlogged revision when a credential changes', () => {
    const make = (accessToken: string) =>
      buildCodexMcpBinding({
        canonicalServers: {
          shortcut: { url: 'https://mcp.example.test', _oauth: { accessToken } },
        },
      });
    expect(make('first').revision).not.toBe(make('second').revision);
  });

  it('keeps the revision when only key order differs', () => {
    const revision = (canonicalServers: Record<string, unknown>) =>
      buildCodexMcpBinding({ canonicalServers }).revision;
    const github = { command: 'gh-mcp', args: ['--stdio'] };
    expect(revision({ Linear: { url: 'https://l.test', headers: { A: '1', b: '2' } }, github })).toBe(
      revision({ github, Linear: { headers: { b: '2', A: '1' }, url: 'https://l.test' } }),
    );
  });

  it('still replaces native MCPs when Frink has no configured servers', () => {
    expect(buildCodexMcpBinding({ canonicalServers: {} }).threadConfig.mcp_servers).toEqual({
      __frink_replace: true,
    });
  });
});
