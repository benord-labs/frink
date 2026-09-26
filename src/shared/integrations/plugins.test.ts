import { describe, expect, it } from 'vitest';
import {
  getPluginDefinition,
  PLUGIN_DEFINITIONS,
  type PluginDefinition,
  type PluginInstallationSnapshot,
  resolvePlugins,
} from './plugins';
import { catalogMcpServers, MCP_PLUGIN_DEFINITIONS } from './catalog';
import { isMcpPluginId } from './installable-plugins';
import { PROVIDERS } from './providers';

/** A required-account fixture: one provider extension, nothing else to satisfy. */
const accountPlugin: PluginDefinition = {
  id: 'acme',
  name: 'Acme',
  description: 'Acme events',
  longDescription: 'Starts a Flow when Acme sends an event.',
  icon: 'acme',
  source: { kind: 'frink_builtin', providerId: 'acme' },
  availability: 'available',
  contents: {
    mcpServers: [],
    skills: [],
    nativeExtensions: [
      {
        id: 'frink.provider.acme',
        kind: 'frink_provider',
        providerId: 'acme',
        flowBinding: 'connection_id',
        connection: { required: true },
      },
    ],
    triggers: [],
    actions: [],
  },
  runtimeSupport: {
    'claude-code': {
      status: 'supported',
      delivers: {
        skills: false,
        commands: false,
        mcp: false,
        flowTriggers: true,
        flowActions: false,
      },
    },
    codex: {
      status: 'supported',
      delivers: {
        skills: false,
        commands: false,
        mcp: false,
        flowTriggers: true,
        flowActions: false,
      },
    },
  },
};

const installedAccountPlugin: PluginInstallationSnapshot = {
  id: 'install-acme',
  pluginId: 'acme',
  sourceKind: 'frink_builtin',
  sourceLocator: null,
  installedVersion: null,
  isInstalled: true,
  isEnabled: true,
};

describe('plugin catalog', () => {
  it('derives every builtin definition and trigger from PROVIDERS, then appends the data catalog', () => {
    expect(PLUGIN_DEFINITIONS.map((plugin) => plugin.id)).toEqual([
      ...PROVIDERS.map((provider) => provider.id),
      ...MCP_PLUGIN_DEFINITIONS.map((plugin) => plugin.id),
    ]);

    for (const provider of PROVIDERS) {
      const plugin = getPluginDefinition(provider.id);
      expect(plugin?.provider).toBe(provider);
      // Every builtin, pinned or not, ends with whatever a data folder attaches to it.
      expect(
        plugin?.contents.mcpServers.slice(-catalogMcpServers(provider.id).length || undefined),
      ).toEqual(
        catalogMcpServers(provider.id).length > 0
          ? catalogMcpServers(provider.id)
          : plugin?.contents.mcpServers,
      );
      expect(plugin?.contents.triggers).toEqual(
        provider.events.map((event) => ({
          id: `${provider.id}.${event.id}`,
          label: event.label,
          description: event.description,
          requirement: event.requirement,
          filterFieldIds: event.filter_field_ids,
          source: { type: 'provider_event', providerId: provider.id, eventId: event.id },
        })),
      );
    }
  });

  it('uses Shortcut HTTP OAuth for every curated action and the generic tool row', () => {
    const plugin = getPluginDefinition('shortcut');
    expect(plugin?.contents.mcpServers).toEqual([
      expect.objectContaining({
        id: 'shortcut',
        ownership: 'provider_native',
        schemaSource: 'mcp_tools_list',
        transport: {
          type: 'http',
          url: 'https://mcp.shortcut.com/mcp',
          auth: { kind: 'frink_client', scope: 'openid read write' },
        },
        connectionBinding: { type: 'none' },
      }),
    ]);
    expect(plugin?.contents.actions).toEqual([
      ...[
        ['create_story', 'stories-create'],
        ['search_stories', 'stories-search'],
        ['get_story', 'stories-get-by-id'],
        ['update_story', 'stories-update'],
        ['create_comment', 'stories-create-comment'],
      ].map(([actionId, toolId]) =>
        expect.objectContaining({
          id: `shortcut.${actionId}`,
          source: { type: 'provider_mcp', serverId: 'shortcut', toolId },
          schemaSource: 'mcp_tools_list',
        }),
      ),
      expect.objectContaining({
        id: 'shortcut.call_tool',
        source: { type: 'provider_mcp', serverId: 'shortcut' },
        schemaSource: 'mcp_tools_list',
      }),
    ]);
    expect(plugin?.contents.nativeExtensions).toContainEqual(
      expect.objectContaining({
        providerId: 'shortcut',
        connection: { required: false },
      }),
    );
  });

  it('names a server the plugin actually declares on every curated row', () => {
    const misrouted = PLUGIN_DEFINITIONS.flatMap((plugin) => {
      const declared = new Set(plugin.contents.mcpServers.map((server) => server.id));
      return plugin.contents.actions
        .filter(
          (action) =>
            action.source.type === 'provider_mcp' && !declared.has(action.source.serverId),
        )
        .map((action) => action.id);
    });
    expect(misrouted).toEqual([]);
  });

  it('dispatches builtin actions through their provider MCP instead of local executors', () => {
    const deterministic = PLUGIN_DEFINITIONS.flatMap((p) =>
      p.contents.actions.filter((a) => a.source.type === 'deterministic_flow').map((a) => a.id),
    );
    expect(deterministic).toEqual([]);
  });

  it('mints call_tool from the catalog helper only: none on a row nobody can connect', () => {
    const unconnectable = PLUGIN_DEFINITIONS.filter((p) => p.availability !== 'available').flatMap(
      (p) => p.contents.actions.filter((a) => a.id === `${p.id}.call_tool`).map(() => p.id),
    );
    expect(unconnectable).toEqual([]);
  });

  it('gives an attachment its data-folder rows beside the account extension', () => {
    const linear = getPluginDefinition('linear');
    expect(linear?.contents.actions.map((a) => a.id).at(-1)).toBe('linear.call_tool');
    expect(linear?.contents.nativeExtensions).toContainEqual(
      expect.objectContaining({ kind: 'frink_provider', providerId: 'linear' }),
    );
  });

  it('keeps the Generic Webhook plugin trigger-only', () => {
    const plugin = getPluginDefinition('generic_webhook');
    expect(plugin?.contents.triggers).toHaveLength(1);
    expect(plugin?.contents.mcpServers).toEqual([]);
    expect(plugin?.contents.actions).toEqual([]);
    expect(plugin?.contents.skills).toEqual([]);
  });

  it.each(['claude-code', 'codex'] as const)(
    'delivers Shortcut HTTP tools and Flow actions to %s',
    (runtime) => {
      expect(getPluginDefinition('shortcut')?.runtimeSupport[runtime]).toEqual({
        status: 'supported',
        delivers: {
          skills: false,
          commands: false,
          mcp: true,
          flowTriggers: true,
          flowActions: true,
        },
      });
    },
  );

  it('attaches the official ClickUp package with optional signed webhook triggers', () => {
    const clickup = getPluginDefinition('clickup');
    expect(clickup?.sourceRef).toEqual({
      repo: 'clickup/clickup-plugin',
      commit: '5c5a8337d7c8ccf498c4643028d03f16fc7df9c6',
    });
    expect(clickup?.contents.mcpServers).toEqual([
      expect.objectContaining({
        id: 'clickup',
        transport: {
          type: 'http',
          url: 'https://mcp.clickup.com/mcp',
          auth: { kind: 'frink_client' },
        },
        connectionBinding: { type: 'none' },
      }),
    ]);
    expect(clickup?.contents.nativeExtensions).toContainEqual({
      id: 'clickup.claude-plugin',
      kind: 'runtime_native',
      runtime: 'claude-code',
      path: '.claude-plugin/plugin.json',
    });
    expect(clickup?.contents.actions.map((action) => action.id)).toEqual([
      'clickup.search',
      'clickup.get_task',
      'clickup.create_task',
      'clickup.update_task',
      'clickup.filter_tasks',
      'clickup.create_task_comment',
      'clickup.get_task_comments',
      'clickup.call_tool',
    ]);
    expect(isMcpPluginId('clickup')).toBe(true);
    expect(clickup?.contents.triggers.map((trigger) => trigger.source.eventId)).toEqual([
      'event_received',
      'task_created',
      'task_status_changed',
      'task_assignee_changed',
      'task_commented',
    ]);
    expect(
      clickup?.contents.nativeExtensions.some(
        (extension) => extension.kind === 'frink_provider' && !extension.connection.required,
      ),
    ).toBe(true);
    expect(clickup?.runtimeSupport['claude-code']).toEqual({
      status: 'supported',
      delivers: { skills: true, commands: false, mcp: true, flowTriggers: true, flowActions: true },
    });
    expect(clickup?.runtimeSupport.codex).toEqual({
      status: 'supported',
      delivers: { skills: true, commands: false, mcp: true, flowTriggers: true, flowActions: true },
    });
  });

  it('delivers portable skills from each official package, including standalone entries', () => {
    for (const id of ['notion', 'neon', 'sentry', 'posthog', 'canva', 'vercel']) {
      const plugin = getPluginDefinition(id);
      expect(plugin?.sourceRef?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(plugin?.contents.nativeExtensions).toContainEqual(
        expect.objectContaining({
          kind: 'runtime_native',
          runtime: 'claude-code',
          path: '.claude-plugin/plugin.json',
        }),
      );
      expect(plugin?.runtimeSupport['claude-code'].delivers.skills).toBe(true);
      expect(plugin?.runtimeSupport.codex.delivers.skills).toBe(true);
      expect(plugin?.contents.mcpServers).toHaveLength(1);
    }
  });

  it.each([
    ['neon', false, true],
    ['vercel', true, true],
    ['supabase', true, false],
    ['generic_webhook', true, false],
    ['clickup', true, true],
  ] as const)(
    'distinguishes inbound and outbound Flow capabilities for %s',
    (id, flowTriggers, flowActions) => {
      const plugin = getPluginDefinition(id)!;
      for (const runtime of Object.values(plugin.runtimeSupport)) {
        expect(runtime.delivers).toMatchObject({ flowTriggers, flowActions });
      }
    },
  );

  it('delivers Supabase official skills while its confidential MCP auth remains unavailable', () => {
    const plugin = getPluginDefinition('supabase')!;
    expect(plugin.sourceRef?.repo).toBe('supabase-community/supabase-plugin');
    expect(plugin.contents.skills.map((skill) => skill.name).sort()).toEqual([
      'supabase',
      'supabase-postgres-best-practices',
    ]);
    expect(plugin.contents.mcpServers).toEqual([]);
    expect(plugin.contents.nativeExtensions).toContainEqual(
      expect.objectContaining({
        kind: 'frink_provider',
        connection: expect.objectContaining({ required: false }),
      }),
    );
    for (const runtime of Object.values(plugin.runtimeSupport)) {
      expect(runtime.delivers).toMatchObject({ skills: true, mcp: false });
    }
  });

  it('states Flows for a plugin no chat runtime can load', () => {
    for (const runtime of ['claude-code', 'codex'] as const) {
      expect(getPluginDefinition('generic_webhook')?.runtimeSupport[runtime]).toMatchObject({
        status: 'unsupported',
        delivers: {
          skills: false,
          commands: false,
          mcp: false,
          flowTriggers: true,
          flowActions: false,
        },
      });
    }
  });

  it('composes Notion tools with verified manual webhook triggers', () => {
    const notion = getPluginDefinition('notion');
    expect(notion?.provider).toMatchObject({
      id: 'notion',
      subscription: 'paste_url',
      webhook_verification: 'notion',
    });
    expect(notion?.source).toEqual({ kind: 'frink_builtin', providerId: 'notion' });
    expect(notion?.contents.triggers.map((trigger) => trigger.id)).toEqual([
      'notion.event_received',
      'notion.page_created',
      'notion.page_updated',
      'notion.comment_added',
      'notion.database_updated',
    ]);
    // Curated rows first, then the generic call-tool node every available http plugin gets.
    expect(notion?.contents.actions.map((a) => a.id)).toEqual([
      'notion.search_pages',
      'notion.read_page',
      'notion.list_recent_pages',
      'notion.read_page_comments',
      'notion.query_database',
      'notion.call_tool',
    ]);
    expect(notion?.contents.nativeExtensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'frink_provider',
          providerId: 'notion',
          flowBinding: 'connection_id',
        }),
      ]),
    );
    expect(notion?.contents.mcpServers).toEqual([
      expect.objectContaining({
        id: 'notion',
        transport: {
          type: 'http',
          url: 'https://mcp.notion.com/mcp',
          auth: { kind: 'frink_client' },
        },
        connectionBinding: { type: 'none' },
      }),
    ]);
    expect(notion?.availability).toBe('available');
    expect(notion?.runtimeSupport['claude-code'].status).toBe('supported');
    // Coming soon rows are listed, never connectable (frink-integration-plugin 2026-09-02).
    const docusign = getPluginDefinition('docusign');
    expect(docusign?.availability).toBe('coming_soon');
    expect(docusign?.contents.mcpServers[0]?.transport).toMatchObject({
      auth: { kind: 'pending' },
    });
    expect(docusign?.runtimeSupport['claude-code']).toEqual({
      status: 'unsupported',
      delivers: {
        skills: false,
        commands: false,
        mcp: false,
        flowTriggers: false,
        flowActions: false,
      },
      reason: expect.stringMatching(/can't be connected yet/),
    });
    expect(resolvePlugins({ definitions: [notion!], installations: [] })[0]).toMatchObject({
      connectionState: 'not_required',
      lifecycle: 'not_installed',
    });
  });

  it('derives launch availability from provider feature gates', () => {
    expect(getPluginDefinition('shortcut')?.availability).toBe('available');
    expect(getPluginDefinition('docusign')?.availability).toBe('coming_soon');
  });
});

describe('resolvePlugins', () => {
  it('does not treat an account connection as install, binding, or authority', () => {
    const [resolved] = resolvePlugins({
      definitions: [accountPlugin],
      installations: [],
      connections: [{ id: 'connection-1', providerId: 'acme', isActive: true }],
    });

    expect(resolved).toMatchObject({
      installation: null,
      installationState: 'not_installed',
      connectionState: 'connected',
      lifecycle: 'not_installed',
      bindings: [],
      grants: [],
    });
  });

  it('keeps multiple accounts under one plugin installation', () => {
    const [resolved] = resolvePlugins({
      definitions: [accountPlugin],
      installations: [installedAccountPlugin],
      connections: [
        { id: 'connection-1', providerId: 'acme', accountName: 'Work', isActive: true },
        { id: 'connection-2', providerId: 'acme', accountName: 'Personal', isActive: true },
      ],
    });

    expect(resolved.lifecycle).toBe('connected');
    expect(resolved.connections.map((connection) => connection.id)).toEqual([
      'connection-1',
      'connection-2',
    ]);
  });

  it('needs a connection while no account answers for a required provider', () => {
    const [resolved] = resolvePlugins({
      definitions: [accountPlugin],
      installations: [installedAccountPlugin],
      connections: [{ id: 'other', providerId: 'other', isActive: true }],
    });

    expect(resolved).toMatchObject({
      connectionState: 'needs_connection',
      lifecycle: 'needs_connection',
    });
    expect(resolved.connections).toEqual([]);
  });

  it('supports a skills-only plugin without requiring a connection', () => {
    const skillsOnly: PluginDefinition = {
      id: 'writing-kit',
      name: 'Writing kit',
      description: 'Reusable writing skills',
      icon: 'sparkles',
      source: { kind: 'agent_plugins_v1', manifestVersion: '1' },
      availability: 'available',
      contents: {
        mcpServers: [],
        skills: [{ id: 'edit', name: 'Edit', path: 'skills/edit' }],
        nativeExtensions: [],
        triggers: [],
        actions: [],
      },
      runtimeSupport: {
        'claude-code': {
          status: 'unsupported',
          delivers: {
            skills: false,
            commands: false,
            mcp: false,
            flowTriggers: false,
            flowActions: false,
          },
          reason: 'Not declared by this package.',
        },
        codex: {
          status: 'supported',
          delivers: {
            skills: false,
            commands: false,
            mcp: true,
            flowTriggers: false,
            flowActions: false,
          },
        },
      },
    };
    const installation: PluginInstallationSnapshot = {
      ...installedAccountPlugin,
      id: 'install-writing-kit',
      pluginId: skillsOnly.id,
      sourceKind: 'agent_plugins_v1',
      sourceLocator: '/plugins/writing-kit',
      installedVersion: '1.0.0',
    };
    const [resolved] = resolvePlugins({
      definitions: [skillsOnly],
      installations: [installation],
    });

    expect(resolved).toMatchObject({
      connectionState: 'not_required',
      lifecycle: 'installed',
    });
  });

  it('joins a differently named plugin through its provider extension', () => {
    const acmeKit: PluginDefinition = {
      ...accountPlugin,
      id: 'acme-kit',
      source: { kind: 'agent_plugins_v1', manifestVersion: '1' },
    };
    const [resolved] = resolvePlugins({
      definitions: [acmeKit],
      installations: [
        {
          ...installedAccountPlugin,
          id: 'install-acme-kit',
          pluginId: 'acme-kit',
          sourceKind: 'agent_plugins_v1',
          sourceLocator: '/plugins/acme-kit',
        },
      ],
      connections: [{ id: 'acme-workspace', providerId: 'acme', isActive: true }],
    });

    expect(resolved).toMatchObject({
      connectionState: 'connected',
      lifecycle: 'connected',
    });
    expect(resolved.connections[0]?.id).toBe('acme-workspace');
  });

  it('retains every account and requires every required provider in a multi-provider package', () => {
    const multiProviderKit: PluginDefinition = {
      ...accountPlugin,
      id: 'project-comms-kit',
      source: { kind: 'agent_plugins_v1', manifestVersion: '1' },
      contents: {
        ...accountPlugin.contents,
        nativeExtensions: [
          ...accountPlugin.contents.nativeExtensions,
          {
            id: 'frink.provider.beta',
            kind: 'frink_provider',
            providerId: 'beta',
            flowBinding: 'connection_id',
            connection: { required: true },
          },
        ],
      },
    };
    const installation: PluginInstallationSnapshot = {
      ...installedAccountPlugin,
      id: 'install-project-comms-kit',
      pluginId: multiProviderKit.id,
      sourceKind: 'agent_plugins_v1',
      sourceLocator: '/plugins/project-comms-kit',
    };
    const betaConnection = { id: 'beta-workspace', providerId: 'beta', isActive: true };

    const [partiallyConnected] = resolvePlugins({
      definitions: [multiProviderKit],
      installations: [installation],
      connections: [betaConnection],
    });
    expect(partiallyConnected.connectionState).toBe('needs_connection');
    expect(partiallyConnected.connections).toEqual([betaConnection]);

    const [fullyConnected] = resolvePlugins({
      definitions: [multiProviderKit],
      installations: [installation],
      connections: [betaConnection, { id: 'acme-workspace', providerId: 'acme', isActive: true }],
    });
    expect(fullyConnected.connectionState).toBe('connected');
    expect(fullyConnected.connections).toHaveLength(2);
  });

  it('keeps disabled and uninstall-tombstone precedence over account state', () => {
    const definitions = [accountPlugin];
    const connections = [{ id: 'connection-1', providerId: 'acme', isActive: true }];

    const [disabled] = resolvePlugins({
      definitions,
      installations: [{ ...installedAccountPlugin, isEnabled: false }],
      connections,
    });
    const [uninstalled] = resolvePlugins({
      definitions,
      installations: [{ ...installedAccountPlugin, isInstalled: false, isEnabled: false }],
      connections,
    });

    expect(disabled.lifecycle).toBe('disabled');
    expect(uninstalled.lifecycle).toBe('not_installed');
  });

  it('filters bindings and grants independently by plugin', () => {
    const [resolved] = resolvePlugins({
      definitions: [accountPlugin],
      installations: [installedAccountPlugin],
      connections: [{ id: 'connection-1', providerId: 'acme', isActive: true }],
      bindings: [
        {
          pluginId: 'acme',
          connectionId: 'connection-1',
          flowId: 'flow-1',
          isActive: true,
        },
      ],
      grants: [
        {
          pluginId: 'acme',
          connectionId: 'connection-1',
          capabilityId: 'mcp:acme:list_events',
          isActive: true,
        },
      ],
    });

    expect(resolved.bindings).toHaveLength(1);
    expect(resolved.grants).toHaveLength(1);
    expect(resolved.lifecycle).toBe('connected');
  });

  it('rejects duplicate definition ids and ignores source-kind mismatches', () => {
    expect(() =>
      resolvePlugins({ definitions: [accountPlugin, accountPlugin], installations: [] }),
    ).toThrow('Duplicate plugin definition id: acme');

    const [mismatched] = resolvePlugins({
      definitions: [accountPlugin],
      installations: [{ ...installedAccountPlugin, sourceKind: 'agent_plugins_v1' }],
    });
    expect(mismatched.installationState).toBe('not_installed');
  });

  it('supports account-free MCPs and rejects dangling provider bindings', () => {
    const accountFreeMcp: PluginDefinition = {
      id: 'local-docs',
      name: 'Local docs',
      description: 'Search local documentation',
      icon: 'book-open',
      source: { kind: 'agent_plugins_v1', manifestVersion: '1' },
      availability: 'available',
      contents: {
        mcpServers: [
          {
            id: 'local-docs',
            label: 'Local docs',
            ownership: 'provider_native',
            schemaSource: 'mcp_tools_list',
            transport: { type: 'stdio', command: 'local-docs-mcp' },
            connectionBinding: { type: 'none' },
          },
        ],
        skills: [],
        nativeExtensions: [],
        triggers: [],
        actions: [],
      },
      runtimeSupport: {
        'claude-code': {
          status: 'unsupported',
          delivers: {
            skills: false,
            commands: false,
            mcp: false,
            flowTriggers: false,
            flowActions: false,
          },
        },
        codex: {
          status: 'supported',
          delivers: {
            skills: false,
            commands: false,
            mcp: true,
            flowTriggers: false,
            flowActions: false,
          },
        },
      },
    };

    expect(
      resolvePlugins({ definitions: [accountFreeMcp], installations: [] })[0]?.connectionState,
    ).toBe('not_required');

    const danglingBinding: PluginDefinition = {
      ...accountFreeMcp,
      contents: {
        ...accountFreeMcp.contents,
        mcpServers: accountFreeMcp.contents.mcpServers.map((server) => ({
          ...server,
          connectionBinding: {
            type: 'frink_selected_connection' as const,
            providerExtensionId: 'missing.provider',
          },
        })),
      },
    };
    expect(() => resolvePlugins({ definitions: [danglingBinding], installations: [] })).toThrow(
      'references unknown provider extension missing.provider',
    );
  });
});

describe('provider wiring', () => {
  it('routes every curated provider to its own extractor', () => {
    // The receiver dispatches on these ids; a provider borrowing another's
    // extractor would silently normalize into the wrong event shape.
    const misrouted = PROVIDERS.filter((p) => p.payload_extractor !== 'generic')
      .filter((p) => p.payload_extractor !== p.id)
      .map((p) => p.id);
    expect(misrouted).toEqual([]);
  });
});

describe('plugin catalog copy', () => {
  it('keeps the one-line row tagline and the page paragraph as two distinct fields', () => {
    const collapsed = PLUGIN_DEFINITIONS.filter(
      (plugin) => !plugin.longDescription || plugin.longDescription === plugin.description,
    ).map((plugin) => plugin.id);
    expect(collapsed).toEqual([]);
  });

  it('keeps every row tagline short enough to render on one line', () => {
    // The row sink truncates silently (PluginGridRow -> ActivityRow), so a long
    // tagline is invisible here and merely looks clipped in the directory.
    const tooLong = PLUGIN_DEFINITIONS.filter((plugin) => plugin.description.length > 48).map(
      (plugin) => plugin.id,
    );
    expect(tooLong).toEqual([]);
  });

  it('never says "agent" for a plugin whose only tools are deterministic Flow steps', () => {
    const reachesAgents = (plugin: PluginDefinition) => plugin.contents.mcpServers.length > 0;
    const overclaiming = PLUGIN_DEFINITIONS.filter(
      (plugin) => !reachesAgents(plugin) && /agent/i.test(plugin.longDescription ?? ''),
    ).map((plugin) => plugin.id);
    expect(overclaiming).toEqual([]);
  });
});
