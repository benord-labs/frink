import { describe, expect, it } from 'vitest';
import { buildUsageProbeOptions } from './usage-probe';

describe('buildUsageProbeOptions', () => {
  const options = buildUsageProbeOptions(
    { token: null, isApiKey: false },
    '/tmp/frink-usage-probe',
    new AbortController(),
  );

  it('starts none of the user hooks, MCP servers, connectors, or IDE integration', () => {
    expect(options).toMatchObject({
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
    });
    expect(options.env).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    });
  });

  it('reads the canonical keychain login from a Frink-owned config dir', () => {
    expect(options.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/tmp/frink-usage-probe',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    });
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
