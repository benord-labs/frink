import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listStagedVendorPluginMcpServers } from './mcp-servers';

describe('listStagedVendorPluginMcpServers', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-plugin-mcp-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  type ManifestBody = {
    name?: string;
    mcpServers?: string | Record<string, { type?: string; url?: string; command?: string }>;
  };
  /** Relative path → manifest body written into the codex projection. */
  function stagePlugin(files: Record<string, ManifestBody>): void {
    const pluginsRoot = path.join(tmpRoot, '.frink', 'plugins');
    const projection = path.join(pluginsRoot, 'projections', 'codex', 'slack', '1.0.0');
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(projection, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(content));
    }
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsRoot, 'staged.json'),
      JSON.stringify({
        plugins: [
          {
            id: 'slack@mkt',
            marketplace: 'mkt',
            name: 'slack',
            version: '1.0.0',
            gitCommitSha: 'x',
            sourceRepo: 'o/r',
            installedAt: 'now',
          },
        ],
      }),
    );
  }

  const slackServer = { type: 'http', url: 'https://mcp.example.com/mcp' };

  it('falls back to the root .mcp.json when the codex manifest declares mcpServers {} (the Slack shape)', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': { name: 'slack', mcpServers: {} },
      '.mcp.json': { mcpServers: { slack: slackServer } },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([
      {
        pluginName: 'slack',
        serverKey: 'slack',
        url: 'https://mcp.example.com/mcp',
      },
    ]);
  });

  it('keeps a valid http server even when a stdio sibling has an empty url', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': {
        name: 'slack',
        mcpServers: {
          local: { type: 'stdio', url: '' },
          slack: { type: 'http', url: 'https://mcp.example.com/mcp' },
        },
      },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([
      { pluginName: 'slack', serverKey: 'slack', url: 'https://mcp.example.com/mcp' },
    ]);
  });

  it('prefers a non-empty codex manifest declaration over the root .mcp.json', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': {
        name: 'slack',
        mcpServers: { native: { url: 'https://native.example.com/mcp' } },
      },
      '.mcp.json': { mcpServers: { slack: slackServer } },
    });
    expect((await listStagedVendorPluginMcpServers()).map((s) => s.serverKey)).toEqual(['native']);
  });

  it('skips url-less (stdio) declarations and tolerates missing files', async () => {
    stagePlugin({
      '.mcp.json': { mcpServers: { local: { type: 'stdio', command: 'npx' } } },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });

  it('the declared type wins over shape: a stdio server carrying a url is NOT an http server', async () => {
    stagePlugin({
      '.mcp.json': { mcpServers: { odd: { type: 'stdio', url: 'https://example.test/mcp' } } },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });

  it.each(['.codex-plugin/plugin.json', '.claude-plugin/plugin.json'])(
    'reads an explicit contained JSON reference from %s',
    async (manifest) => {
      stagePlugin({
        [manifest]: { mcpServers: './agents/native/mcp.json' },
        'agents/native/mcp.json': { mcpServers: { native: slackServer } },
      });
      expect((await listStagedVendorPluginMcpServers()).map((server) => server.serverKey)).toEqual([
        'native',
      ]);
    },
  );

  it('falls through an empty Codex declaration to Claude inline servers before the root file', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': { mcpServers: {} },
      '.claude-plugin/plugin.json': { mcpServers: { claude: slackServer } },
      '.mcp.json': { mcpServers: { fallback: slackServer } },
    });
    expect((await listStagedVendorPluginMcpServers()).map((server) => server.serverKey)).toEqual([
      'claude',
    ]);
  });

  it.each(['./missing.json', '../outside.json', '/tmp/outside.json'])(
    'does not fall through an invalid explicit reference %s',
    async (reference) => {
      stagePlugin({
        '.codex-plugin/plugin.json': { mcpServers: reference },
        '.claude-plugin/plugin.json': { mcpServers: { claude: slackServer } },
        '.mcp.json': { mcpServers: { fallback: slackServer } },
      });
      expect(await listStagedVendorPluginMcpServers()).toEqual([]);
    },
  );

  it.each(['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'linked.json'])(
    'rejects a symlink escape through %s',
    async (escape) => {
      stagePlugin({
        '.codex-plugin/plugin.json':
          escape === 'linked.json' ? { mcpServers: './linked.json' } : {},
        '.claude-plugin/plugin.json': {},
        '.mcp.json': { mcpServers: { fallback: slackServer } },
      });
      const outside = path.join(tmpRoot, 'outside.json');
      fs.writeFileSync(outside, JSON.stringify({ mcpServers: { escaped: slackServer } }));
      const file = path.join(tmpRoot, '.frink/plugins/projections/codex/slack/1.0.0', escape);
      fs.rmSync(file, { force: true });
      fs.symlinkSync(outside, file);
      expect(await listStagedVendorPluginMcpServers()).toEqual([]);
    },
  );

  it('rejects malformed and recursive referenced JSON instead of using fallback servers', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': { mcpServers: './mcp.json' },
      'mcp.json': { mcpServers: './.mcp.json' },
      '.mcp.json': { mcpServers: { fallback: slackServer } },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
    fs.writeFileSync(
      path.join(tmpRoot, '.frink/plugins/projections/codex/slack/1.0.0/mcp.json'),
      '{broken',
    );
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });

  it('reads root mcp.json only when a native manifest explicitly references it', async () => {
    stagePlugin({ 'mcp.json': { mcpServers: { neon: slackServer } } });
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
    stagePlugin({ '.claude-plugin/plugin.json': { mcpServers: './mcp.json' } });
    expect((await listStagedVendorPluginMcpServers()).map((server) => server.serverKey)).toEqual([
      'neon',
    ]);
  });

  it('does not fall through a broken Claude reference when Codex has no declaration', async () => {
    stagePlugin({
      '.codex-plugin/plugin.json': {},
      '.claude-plugin/plugin.json': { mcpServers: './missing.json' },
      '.mcp.json': { mcpServers: { fallback: slackServer } },
    });
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });

  it('rejects a dangling manifest symlink instead of treating it as absent', async () => {
    stagePlugin({ '.mcp.json': { mcpServers: { fallback: slackServer } } });
    const projection = path.join(tmpRoot, '.frink/plugins/projections/codex/slack/1.0.0');
    fs.mkdirSync(path.join(projection, '.codex-plugin'));
    fs.symlinkSync(
      path.join(tmpRoot, 'missing.json'),
      path.join(projection, '.codex-plugin/plugin.json'),
    );
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });

  it('returns nothing when no plugins are staged', async () => {
    expect(await listStagedVendorPluginMcpServers()).toEqual([]);
  });
});
