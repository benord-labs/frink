import { describe, expect, it } from 'vitest';
import { pluginMcpOwner } from './constants';

const pluginMcpTitle = (...args: Parameters<typeof pluginMcpOwner>) =>
  pluginMcpOwner(...args)?.title ?? null;

const VENDOR_PLUGIN = { managedBy: 'vendor_plugin' };
const CONNECTION_ID = '0d9f2c1e-7b3a-4e5f-9a1b-2c3d4e5f6a7b';

const twoServerCatalog = [
  { id: 'acme', name: 'Acme', contents: { mcpServers: [{ id: 'reports' }, { id: 'admin' }] } },
];

describe('pluginMcpOwner', () => {
  it('leaves a server the user added alone, whatever it is called', () => {
    expect(pluginMcpTitle('my-server', {})).toBeNull();
    // The name is not the marker: a user's own Shortcut MCP under a lookalike key stays theirs.
    expect(pluginMcpTitle(`shortcut-${CONNECTION_ID}`, {})).toBeNull();
    expect(pluginMcpTitle('plugin_posthog_posthog', {})).toBeNull();
  });

  it("names a plugin's vendor server after the plugin, not its registry key", () => {
    expect(pluginMcpTitle('plugin_posthog_posthog', VENDOR_PLUGIN)).toBe('PostHog');
  });

  it('adds the server id only when one plugin ships several servers', () => {
    const oneServerCatalog = [
      { id: 'acme', name: 'Acme', contents: { mcpServers: [{ id: 'reports' }] } },
    ];
    expect(pluginMcpTitle('plugin_acme_reports', VENDOR_PLUGIN, oneServerCatalog)).toBe('Acme');
    expect(pluginMcpTitle('plugin_acme_reports', VENDOR_PLUGIN, twoServerCatalog)).toBe(
      'Acme · reports',
    );
  });

  it('carries the plugin id so the row can show its mark', () => {
    expect(pluginMcpOwner('plugin_posthog_posthog', VENDOR_PLUGIN)?.id).toBe('posthog');
  });

  it('hands a server the catalog no longer names back to the user', () => {
    expect(pluginMcpTitle('plugin_retired_main', VENDOR_PLUGIN)).toBeNull();
  });
});
