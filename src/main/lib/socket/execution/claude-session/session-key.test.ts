import { describe, expect, it } from 'vitest';
import { computeClaudeSessionKey, diffKeyParts } from './session-key';

const options = (overrides: Record<string, unknown> = {}) => ({
  cwd: '/work/project',
  permissionMode: 'default',
  env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-a', CLAUDE_CONFIG_DIR: '/cfg/sub-1' },
  resume: 'sess-1',
  stderr: () => {},
  systemPrompt: { type: 'preset', preset: 'claude_code', append: '\n\nfrink' },
  settingSources: ['project', 'user'],
  agents: { reviewer: { description: 'r', prompt: 'p' }, planner: { description: 'q' } },
  extraArgs: { 'mcp-config': '/cfg/sub-1/mcp-config-a.json' },
  model: 'claude-opus-4-7',
  hooks: { Stop: [{ hooks: [() => ({})] }] },
  canUseTool: async () => ({ behavior: 'allow' }),
  ...overrides,
});
const servers = (token = 'secret-token-a') => ({
  linear: { type: 'http', url: 'https://mcp.linear.test', headers: { Authorization: token } },
  frink_dynamic_chat: { type: 'http', url: 'http://127.0.0.1:9/mcp?channel=c1&toolset=agent' },
});

describe('computeClaudeSessionKey', () => {
  it('is deterministic for the same inputs', () => {
    expect(computeClaudeSessionKey(options(), servers())).toEqual(
      computeClaudeSessionKey(options(), servers()),
    );
  });

  it('ignores the staged mcp-config path, resume, permission mode and callbacks', () => {
    const changed = options({
      extraArgs: { 'mcp-config': '/cfg/sub-1/mcp-config-b.json' },
      resume: undefined,
      permissionMode: 'plan',
      stderr: () => 1,
      hooks: {},
      canUseTool: undefined,
    });
    expect(computeClaudeSessionKey(changed, servers())).toEqual(
      computeClaudeSessionKey(options(), servers()),
    );
  });

  it('ignores the dynamic-chat channel each CLI mints, but not the toolset beside it', () => {
    const dynamicChat = (query: string) => ({
      ...servers(),
      frink_dynamic_chat: { type: 'http', url: `http://127.0.0.1:9/mcp?${query}` },
    });
    const key = (query: string) => computeClaudeSessionKey(options(), dynamicChat(query));

    expect(key('channel=c2&toolset=agent:nosignal')).toEqual(
      key('channel=c1&toolset=agent:nosignal'),
    );
    expect(key('channel=c1&toolset=plan:nosignal')).not.toEqual(
      key('channel=c1&toolset=agent:nosignal'),
    );
  });

  it('is insensitive to agent registration order', () => {
    const reordered = options({
      agents: { planner: { description: 'q' }, reviewer: { prompt: 'p', description: 'r' } },
    });
    expect(computeClaudeSessionKey(reordered, servers())).toEqual(
      computeClaudeSessionKey(options(), servers()),
    );
  });

  it('reports an OAuth header change as the mcpServers part only, never the value', () => {
    const before = computeClaudeSessionKey(options(), servers('secret-token-a'));
    const after = computeClaudeSessionKey(options(), servers('secret-token-b'));

    expect(diffKeyParts(before, after)).toEqual(['mcpServers']);
    expect(JSON.stringify(after)).not.toContain('secret-token');
  });

  it('names each frozen option that changed, including one only one side has', () => {
    const before = computeClaudeSessionKey(options(), servers());
    const after = computeClaudeSessionKey(
      options({ cwd: '/work/other', thinking: { type: 'adaptive' }, betas: ['context-1m'] }),
      servers(),
    );
    expect(diffKeyParts(before, after).sort()).toEqual(['betas', 'cwd', 'thinking']);
  });

  it('leaves model, effort and Ultra out of the key: a claim sets them live', () => {
    const before = computeClaudeSessionKey(options({ effort: 'high' }), servers());
    const after = computeClaudeSessionKey(
      options({ model: 'claude-sonnet-5', effort: 'low', settings: { ultracode: true } }),
      servers(),
    );
    expect(diffKeyParts(before, after)).toEqual([]);
  });

  it('keys max effort, which has no live setting', () => {
    const high = computeClaudeSessionKey(options({ effort: 'high' }), servers());
    const max = computeClaudeSessionKey(options({ effort: 'max' }), servers());
    expect(diffKeyParts(high, max)).toEqual(['effort']);
  });
});
