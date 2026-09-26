import { describe, expect, it } from 'vitest';
import type {
  PluginConnection,
  PluginDefinition,
  ResolvedPlugin,
} from '../../../shared/integrations/plugins';
import { PLUGIN_DEFINITIONS, resolvePlugins } from '../../../shared/integrations/plugins';
import {
  applyFilter,
  buildFilters,
  groupIdFor,
  groupPlugins,
  type PluginToolsStates,
  searchPlugins,
} from './plugin-filters';
import { resolvePluginStatus } from './plugin-view-model';

function catalog(connections: ReadonlyArray<PluginConnection> = []): ResolvedPlugin[] {
  return [...resolvePlugins({ installations: [], connections })];
}

const NOTHING_CONNECTED = catalog();
const SHORTCUT_CONNECTED = catalog([{ id: 'conn-1', providerId: 'shortcut', isActive: true }]);

function idsIn(plugins: ResolvedPlugin[]): string[] {
  return plugins.map((plugin) => plugin.definition.id);
}

describe('groupIdFor', () => {
  it('groups by live connection, not by installation', () => {
    const shortcut = SHORTCUT_CONNECTED.find((p) => p.definition.id === 'shortcut');
    if (!shortcut) throw new Error('shortcut missing');

    // Nothing writes plugin_installations yet, so this is still `not_installed`.
    expect(shortcut.lifecycle).toBe('not_installed');
    expect(groupIdFor(shortcut)).toBe('connected');
  });

  it('files a Coming soon catalog plugin under coming soon regardless of connections', () => {
    const docusign = NOTHING_CONNECTED.find((p) => p.definition.id === 'docusign');
    if (!docusign) throw new Error('docusign missing');
    expect(groupIdFor(docusign)).toBe('coming_soon');
  });

  it('separates a launch-gated provider from an unshipped one', () => {
    // Both are unusable, for different reasons. Folding them together would put
    // a plugin under "Coming soon" while its own badge read "Unavailable".
    const [gated] = resolvePlugins({
      definitions: [
        {
          ...(NOTHING_CONNECTED[0] as ResolvedPlugin).definition,
          id: 'gated',
          availability: 'disabled',
        },
      ],
      installations: [],
    });
    if (!gated) throw new Error('gated plugin missing');
    expect(groupIdFor(gated)).toBe('unavailable');
  });

  it('treats an inactive connection as not connected', () => {
    const [shortcut] = catalog([{ id: 'conn-1', providerId: 'shortcut', isActive: false }]).filter(
      (p) => p.definition.id === 'shortcut',
    );
    if (!shortcut) throw new Error('shortcut missing');
    expect(groupIdFor(shortcut)).toBe('available');
  });

  it('files an installed plugin with no account under Available, never Connected', () => {
    const [linear] = resolvePlugins({
      installations: [
        {
          id: 'install-linear',
          pluginId: 'linear',
          sourceKind: 'frink_builtin',
          sourceLocator: null,
          installedVersion: null,
          isInstalled: true,
          isEnabled: true,
        },
      ],
    }).filter((p) => p.definition.id === 'linear');
    if (!linear) throw new Error('linear missing');
    expect(groupIdFor(linear)).toBe('available');
  });
});

describe('groupPlugins', () => {
  it('drops empty groups so no header renders over nothing', () => {
    const groups = groupPlugins(NOTHING_CONNECTED);
    // Every provider ships in this build; the unverified catalog rows sit under Coming soon.
    expect(groups.map((group) => group.id)).toEqual(['available', 'coming_soon']);
    expect(groups.every((group) => group.plugins.length > 0)).toBe(true);
  });

  it('surfaces a Connected group once an account is live', () => {
    const groups = groupPlugins(SHORTCUT_CONNECTED);
    expect(groups[0]?.id).toBe('connected');
    expect(idsIn(groups[0]?.plugins ?? [])).toEqual(['shortcut']);
  });
});

describe('buildFilters', () => {
  it('offers All plus only the groups that have members', () => {
    const filters = buildFilters(NOTHING_CONNECTED);
    expect(filters.map((filter) => filter.id)).toEqual(['all', 'available', 'coming_soon']);
    expect(filters[0]?.count).toBe(NOTHING_CONNECTED.length);
  });

  it('never emits a zero-count filter', () => {
    for (const plugins of [NOTHING_CONNECTED, SHORTCUT_CONNECTED]) {
      expect(buildFilters(plugins).every((filter) => filter.count > 0)).toBe(true);
    }
  });
});

describe('searchPlugins', () => {
  it('returns everything for an empty query', () => {
    expect(searchPlugins(NOTHING_CONNECTED, '   ')).toHaveLength(NOTHING_CONNECTED.length);
  });

  it('matches on name case-insensitively', () => {
    expect(idsIn(searchPlugins(NOTHING_CONNECTED, 'shortCUT'))).toEqual(['shortcut']);
  });

  it('matches on a trigger label, not just the name', () => {
    const matches = idsIn(searchPlugins(NOTHING_CONNECTED, 'issue'));
    expect(matches).toContain('linear');
  });

  it('matches a catalog keyword the name never mentions', () => {
    expect(idsIn(searchPlugins(NOTHING_CONNECTED, 'wiki'))).toContain('notion');
  });

  it('returns nothing when a query matches no plugin', () => {
    expect(searchPlugins(NOTHING_CONNECTED, 'zzzzz')).toHaveLength(0);
  });
});

describe('applyFilter', () => {
  it('passes everything through for all', () => {
    expect(applyFilter(NOTHING_CONNECTED, 'all')).toHaveLength(NOTHING_CONNECTED.length);
  });

  it('narrows to a single group', () => {
    const comingSoon = applyFilter(NOTHING_CONNECTED, 'coming_soon');
    expect(comingSoon.every((plugin) => groupIdFor(plugin) === 'coming_soon')).toBe(true);
    expect(comingSoon.length).toBeGreaterThan(0);
  });
});

const CHAT_ONLY: PluginDefinition = {
  ...PLUGIN_DEFINITIONS[0]!,
  id: 'wiki',
  name: 'Wiki',
  source: { kind: 'frink_builtin' },
  availability: 'available',
  contents: {
    mcpServers: [
      {
        id: 'wiki',
        label: 'Wiki',
        ownership: 'provider_native',
        schemaSource: 'mcp_tools_list',
        transport: {
          type: 'http',
          url: 'https://mcp.wiki.test/mcp',
          auth: { kind: 'frink_client' },
        },
        connectionBinding: { type: 'none' },
      },
    ],
    skills: [],
    nativeExtensions: [],
    triggers: [],
    actions: [],
  },
};

describe('chat-only plugins in the directory', () => {
  const [wiki] = resolvePlugins({ definitions: [CHAT_ONLY], installations: [] });
  if (!wiki) throw new Error('wiki missing');

  it('files under Available until the chat grant exists, then under Connected', () => {
    const granted: PluginToolsStates = new Map([['wiki', 'connected']]);
    expect(groupIdFor(wiki)).toBe('available');
    expect(groupIdFor(wiki, 'connected')).toBe('connected');
    expect(idsIn(applyFilter([wiki], 'connected', granted))).toEqual(['wiki']);
    expect(buildFilters([wiki], granted)[1]).toMatchObject({
      id: 'connected',
      count: 1,
    });
    expect(groupPlugins([wiki], granted)[0]?.id).toBe('connected');
  });
});
