import { describe, expect, it } from 'vitest';
import {
  FRINK_MUTATING_FLOW_TOOLS,
  FRINK_OWNED_MCP_SERVERS,
  formatMcpToolName,
  isVendorPluginMcpServer,
  isFrinkMutatingFlowTool,
  isFrinkOwnedMcpTool,
  parseMcpToolFullName,
  vendorPluginMcpServerName,
} from './mcp-tool-name';

describe('parseMcpToolFullName', () => {
  it('parses mcp__server__tool into components', () => {
    expect(parseMcpToolFullName('mcp__codebase__searchCode')).toEqual({
      serverName: 'codebase',
      toolName: 'searchCode',
    });
  });

  it('preserves trailing double-underscore inside the tool name', () => {
    expect(parseMcpToolFullName('mcp__server__a__b')).toEqual({
      serverName: 'server',
      toolName: 'a__b',
    });
  });

  it('returns null when prefix is missing', () => {
    expect(parseMcpToolFullName('tool-mcp__server__tool')).toBeNull();
    expect(parseMcpToolFullName('foo__server__tool')).toBeNull();
  });

  it('returns null when server separator is missing', () => {
    expect(parseMcpToolFullName('mcp__onlyone')).toBeNull();
  });

  it('returns null when server or tool name is empty', () => {
    expect(parseMcpToolFullName('mcp____tool')).toBeNull();
    expect(parseMcpToolFullName('mcp__server__')).toBeNull();
  });
});

describe('isFrinkOwnedMcpTool', () => {
  it('is true for frink-owned servers', () => {
    expect(isFrinkOwnedMcpTool('mcp__frink_dynamic_chat__frink_flows_patch')).toBe(true);
    expect(isFrinkOwnedMcpTool('mcp__frink__frink_flows_list')).toBe(true);
  });

  it('is false for a server whose name merely contains "frink" (substring trap)', () => {
    expect(isFrinkOwnedMcpTool('mcp__shortcut-frink__stories-list')).toBe(false);
  });

  it('is false for third-party servers and malformed names', () => {
    expect(isFrinkOwnedMcpTool('mcp__codebase__searchCode')).toBe(false);
    expect(isFrinkOwnedMcpTool('tool-mcp__frink_dynamic_chat__x')).toBe(false);
    expect(isFrinkOwnedMcpTool('frink_flows_list')).toBe(false);
    expect(isFrinkOwnedMcpTool('mcp__onlyone')).toBe(false);
  });

  it('trusts EXACTLY the two frink keys — locks the silent-trust boundary against drift', () => {
    // This set is a security boundary: every member is auto-approved with no prompt.
    // A widened set (extra entry, or a mutation via the shared FRINK_LOOPBACK_KEYS alias)
    // would silently trust a non-frink server. Lock membership exactly.
    expect([...FRINK_OWNED_MCP_SERVERS].sort()).toEqual(['frink', 'frink_dynamic_chat']);
  });
});

describe('isFrinkMutatingFlowTool', () => {
  it('is true for every mutating flow tool under BOTH frink server keys', () => {
    // The same tools are served under `frink_dynamic_chat` (in-app) and `frink`
    // (~/.claude.json mirror). A key missed here would silently auto-allow that
    // identity's writes at the trust short-circuit.
    for (const tool of FRINK_MUTATING_FLOW_TOOLS) {
      expect(isFrinkMutatingFlowTool(`mcp__frink_dynamic_chat__${tool}`)).toBe(true);
      expect(isFrinkMutatingFlowTool(`mcp__frink__${tool}`)).toBe(true);
    }
  });

  it('is false for read-only frink tools (they keep trust auto-allow)', () => {
    expect(isFrinkMutatingFlowTool('mcp__frink_dynamic_chat__frink_flows_list')).toBe(false);
    expect(isFrinkMutatingFlowTool('mcp__frink_dynamic_chat__frink_navigation_context')).toBe(
      false,
    );
  });

  it('is false for a third-party server carrying a flow-tool name (server spoof)', () => {
    // Routing on the bare tool name alone would let a foreign server's tool
    // named `frink_flows_patch` skip the third-party checkMcp path.
    expect(isFrinkMutatingFlowTool('mcp__evil__frink_flows_patch')).toBe(false);
  });

  it('is false for malformed and bare names', () => {
    expect(isFrinkMutatingFlowTool('frink_flows_patch')).toBe(false);
    expect(isFrinkMutatingFlowTool('mcp__frink_dynamic_chat__')).toBe(false);
  });
});

describe('formatMcpToolName', () => {
  it('converts underscores to spaces and title-cases each word', () => {
    expect(formatMcpToolName('search_items')).toBe('Search Items');
    expect(formatMcpToolName('list_active_users')).toBe('List Active Users');
  });

  it('collapses repeated whitespace', () => {
    expect(formatMcpToolName('foo__bar')).toBe('Foo Bar');
  });

  it('preserves camelCase when no underscores are present', () => {
    expect(formatMcpToolName('searchCode')).toBe('SearchCode');
  });

  it('trims leading and trailing whitespace', () => {
    expect(formatMcpToolName('_foo_bar_')).toBe('Foo Bar');
  });
});

describe('isVendorPluginMcpServer', () => {
  it('recognizes claude-code plugin server namespacing', () => {
    expect(isVendorPluginMcpServer('plugin_slack_slack')).toBe(true);
    expect(isVendorPluginMcpServer('shortcut')).toBe(false);
  });
});

describe('vendorPluginMcpServerName', () => {
  it('composes the claude-code-identical namespaced key', () => {
    expect(vendorPluginMcpServerName('slack', 'slack')).toBe('plugin_slack_slack');
  });

  it('rejects parts that would embed __ and corrupt the tool-name parse', () => {
    expect(vendorPluginMcpServerName('foo_', 'bar')).toBeNull();
    expect(vendorPluginMcpServerName('foo', '_bar')).toBeNull();
  });

  it('rejects a trailing _ — it would fuse with the __ tool separator and shift the parse', () => {
    expect(vendorPluginMcpServerName('slack', 'api_')).toBeNull();
  });

  it('rejects non-word characters (a marketplace-qualified id is not a valid key)', () => {
    expect(vendorPluginMcpServerName('slack@claude-plugins-official', 'slack')).toBeNull();
  });

  it('round-trips through parseMcpToolFullName as the server component', () => {
    const name = vendorPluginMcpServerName('slack', 'slack');
    const parsed = parseMcpToolFullName(`mcp__${name}__slack_search_channels`);
    expect(parsed).toEqual({ serverName: 'plugin_slack_slack', toolName: 'slack_search_channels' });
    expect(isVendorPluginMcpServer(parsed?.serverName ?? '')).toBe(true);
  });
});

it('uses the official package name for both catalog and native runtime server references', () => {
  expect(vendorPluginMcpServerName('huggingface', 'huggingface-skills')).toBe(
    'plugin_huggingface-skills_huggingface-skills',
  );
  expect(vendorPluginMcpServerName('huggingface-skills', 'huggingface-skills')).toBe(
    'plugin_huggingface-skills_huggingface-skills',
  );
});
