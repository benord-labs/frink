import { describe, expect, it } from 'vitest';
import type {
  PluginConnection,
  PluginDefinition,
  PluginInstallationSnapshot,
  ResolvedPlugin,
} from '../../../shared/integrations/plugins';
import { PLUGIN_DEFINITIONS, resolvePlugins } from '../../../shared/integrations/plugins';
import {
  capabilityCounts,
  connectionLabel,
  connectSubline,
  hasChatMcp,
  isChatOnlyPlugin,
  pluginConnectAction,
  pluginSourceUrl,
  resolvePluginStatus,
  toCapabilityRows,
} from './plugin-view-model';

function definition(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    description: 'A plugin used by tests.',
    icon: 'plug',
    source: { kind: 'frink_builtin', providerId: 'test-plugin' },
    availability: 'available',
    contents: { mcpServers: [], skills: [], nativeExtensions: [], triggers: [], actions: [] },
    runtimeSupport: {
      'claude-code': {
        status: 'supported',
        delivers: {
          skills: false,
          commands: false,
          mcp: true,
          flowTriggers: false,
          flowActions: false,
        },
      },
      codex: {
        status: 'unsupported',
        delivers: {
          skills: false,
          commands: false,
          mcp: false,
          flowTriggers: false,
          flowActions: false,
        },
        reason: 'Not verified.',
      },
    },
    ...overrides,
  };
}

function installation(overrides: Partial<PluginInstallationSnapshot> = {}) {
  return {
    id: 'install-1',
    pluginId: 'test-plugin',
    sourceKind: 'frink_builtin' as const,
    sourceLocator: null,
    installedVersion: null,
    isInstalled: true,
    isEnabled: true,
    ...overrides,
  };
}

function resolveOne(
  def: PluginDefinition,
  installations: PluginInstallationSnapshot[],
  connections: ReadonlyArray<PluginConnection> = [],
): ResolvedPlugin {
  const [plugin] = resolvePlugins({ definitions: [def], installations, connections });
  if (!plugin) throw new Error('resolvePlugins returned nothing');
  return plugin;
}

const TEST_ACCOUNT: PluginConnection = {
  id: 'conn-1',
  providerId: 'test-plugin',
  isActive: true,
};

const CONNECTED_PLUGIN = definition({
  contents: {
    mcpServers: [],
    skills: [],
    nativeExtensions: [
      {
        id: 'frink.provider.test-plugin',
        kind: 'frink_provider',
        providerId: 'test-plugin',
        flowBinding: 'connection_id',
        connection: { required: true },
      },
    ],
    triggers: [],
    actions: [],
  },
});

describe('resolvePluginStatus', () => {
  it('reports Coming soon only while nothing is installed; an existing install keeps its real state', () => {
    const soon = resolveOne(definition({ availability: 'coming_soon' }), []);
    expect(resolvePluginStatus(soon)).toMatchObject({ id: 'coming_soon', label: 'Coming soon' });
    const turnedOff = resolveOne(definition({ availability: 'coming_soon' }), [
      installation({ isEnabled: false }),
    ]);
    expect(resolvePluginStatus(turnedOff).id).toBe('disabled');
  });

  it('reports a launch-gated plugin as Unavailable', () => {
    const unavailable = resolveOne(definition({ availability: 'disabled' }), []);
    expect(resolvePluginStatus(unavailable).label).toBe('Unavailable');
  });

  it('reports a working account on a launch-gated provider as Connected', () => {
    const gated = resolveOne(
      definition({ availability: 'disabled', contents: CONNECTED_PLUGIN.contents }),
      [],
      [TEST_ACCOUNT],
    );

    // The directory lists this account so it stays readable and disconnectable
    // after its provider is turned off. Reporting "Unavailable" filed it under
    // a section with no manage route, stranding the account it deliberately
    // still shows.
    expect(resolvePluginStatus(gated)).toMatchObject({ id: 'connected', tone: 'success' });
  });

  it('reports Needs connection when an installed plugin has no account', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [installation()]);
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'needs_connection' });
  });

  it('reports Connected for a live account even though installation is never written', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [], [TEST_ACCOUNT]);

    // Nothing writes plugin_installations, so lifecycle short-circuits here.
    // The badge must not inherit that and contradict the Accounts list beside it.
    expect(plugin.lifecycle).toBe('not_installed');
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'connected', tone: 'success' });
  });

  it('an explicit disable outranks a live account — Connected must not mask Turned off [sc-2068]', () => {
    const plugin = resolveOne(
      CONNECTED_PLUGIN,
      [installation({ isEnabled: false })],
      [TEST_ACCOUNT],
    );
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'disabled', label: 'Turned off' });
  });

  it('a disabled plugin offers no connect action [sc-2068]', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [installation({ isEnabled: false })]);
    const status = resolvePluginStatus(plugin);
    expect(pluginConnectAction(plugin, status, false)).toBeNull();
  });

  it('reports Connected once a required account is active', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [installation()], [TEST_ACCOUNT]);
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'connected', tone: 'success' });
  });

  it('reports Connected for an installed package that needs no account', () => {
    const plugin = resolveOne(definition(), [installation()]);
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'connected', label: 'Connected' });
  });

  it('offers Connect for an uninstalled account-free package instead of claiming readiness', () => {
    const plugin = resolveOne(definition(), []);
    const status = resolvePluginStatus(plugin);
    expect(status.id).toBe('needs_connection');
    expect(pluginConnectAction(plugin, status, false)?.label).toBe('Connect');
  });
});

describe('pluginConnectAction', () => {
  it('renders no button for a healthy connected provider', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [], [TEST_ACCOUNT]);
    expect(pluginConnectAction(plugin, resolvePluginStatus(plugin), false)).toBeNull();
  });

  it('keeps plain Connect while no account answers for the provider', () => {
    // Labelled plain Connect: the button mints a fresh session, and claiming
    // in-place reconnection would be false until the reconnect coordinator's
    // completion is observable from the browser flow.
    const plugin = resolveOne(CONNECTED_PLUGIN, []);
    const action = pluginConnectAction(plugin, resolvePluginStatus(plugin), false);
    expect(action).toMatchObject({ label: 'Connect', ariaLabel: 'Connect Test Plugin' });
  });

  it('does not offer another connection on a connected webhook plugin', () => {
    const webhook = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'generic_webhook');
    if (!webhook) throw new Error('generic_webhook definition missing');
    const plugin = resolveOne(
      webhook,
      [],
      [{ id: 'hook-1', providerId: 'generic_webhook', isActive: true }],
    );
    expect(resolvePluginStatus(plugin).id).toBe('connected');
    expect(pluginConnectAction(plugin, resolvePluginStatus(plugin), false)).toBeNull();
  });

  it('treats a webhook-only provider with chat tools as chat-only: Connect is the consent, and it goes once granted', () => {
    // PostHog's endpoint row is optional and minted from its Triggers card, so the header
    // must neither demand an account nor offer to "Add" one.
    const posthog = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'posthog');
    if (!posthog) throw new Error('posthog definition missing');
    expect(isChatOnlyPlugin(posthog)).toBe(true);
    const plugin = resolveOne(posthog, []);
    expect(connectSubline(plugin, 'awaiting')).toBe('One sign-in in your browser.');
    expect(resolvePluginStatus(plugin, 'awaiting').id).toBe('needs_connection');
    const connected = resolvePluginStatus(plugin, 'connected');
    expect(connected.id).toBe('connected');
    expect(pluginConnectAction(plugin, connected, false)).toBeNull();
    const withEndpoint = resolveOne(
      posthog,
      [],
      [{ id: 'hook-1', providerId: 'posthog', isActive: true }],
    );
    expect(pluginConnectAction(withEndpoint, resolvePluginStatus(withEndpoint), false)).toBeNull();
  });
});

describe('toCapabilityRows', () => {
  it('returns every row even when the plugin supplies nothing, with honest empty copy', () => {
    const rows = toCapabilityRows(resolveOne(definition(), []));

    expect(rows.map((row) => row.id)).toEqual([
      'source',
      'auth',
      'accounts',
      'skills',
      'agent-tools',
      'triggers',
      'works-in',
    ]);
    expect(rows.find((row) => row.id === 'skills')?.emptyCopy).toBe('No skills in this plugin.');
    expect(rows.find((row) => row.id === 'agent-tools')?.items).toHaveLength(0);
    expect(rows.find((row) => row.id === 'auth')).toMatchObject({
      items: [],
      emptyCopy: 'No account needed.',
    });
  });

  it('lists every reachable runtime, so an unsupported one is never silently omitted', () => {
    const rows = toCapabilityRows(resolveOne(definition(), []));
    const runtimes = rows.find((row) => row.id === 'works-in');

    expect(runtimes?.items.map((item) => item.label)).toEqual(['Claude Code', 'Codex']);
    // Delivery rides as facts; prose is kept for the runtime that gets nothing.
    expect(runtimes?.items[0]).toMatchObject({
      delivers: {
        skills: false,
        commands: false,
        mcp: true,
        flowTriggers: false,
        flowActions: false,
      },
      note: undefined,
    });
    // An unsupported runtime keeps its chat reason and both Flow cells both.
    expect(runtimes?.items[1]?.delivers).toMatchObject({ flowTriggers: false, flowActions: false });
    expect(runtimes?.items[1]).toMatchObject({ note: 'Not verified.' });
  });

  it('links the Source fact to the package at its pinned revision, and only then', () => {
    const unpinned = toCapabilityRows(resolveOne(definition(), []));
    expect(unpinned.find((row) => row.id === 'source')?.items[0]?.href).toBeUndefined();

    const pinned = toCapabilityRows(
      resolveOne(
        definition({
          sourceRef: { repo: 'cursor/plugins', commit: '4612556', path: 'third_party/x' },
        }),
        [],
      ),
    );
    expect(pinned.find((row) => row.id === 'source')?.items[0]?.href).toBe(
      'https://github.com/cursor/plugins/tree/4612556/third_party/x',
    );
    expect(pluginSourceUrl({ repo: 'a/b', commit: 'abc1234' })).toBe(
      'https://github.com/a/b/tree/abc1234',
    );
  });

  it.each([
    ['profound', 'Official documentation', 'https://docs.tryprofound.com/mcp/overview'],
    ['intercom', 'Official plugin', 'https://github.com/intercom/claude-plugin-external'],
    [
      'github',
      'Official plugin',
      'https://github.com/github/github-mcp-server/tree/main/agent-plugin',
    ],
  ])(
    'links %s to its official destination without changing package provenance',
    (id, hrefLabel, href) => {
      const plugin = resolvePlugins({ installations: [] }).find(
        (entry) => entry.definition.id === id,
      )!;
      expect(toCapabilityRows(plugin).find((row) => row.id === 'source')?.items[0]).toMatchObject({
        href,
        hrefLabel,
      });
      expect(plugin.definition.sourceRef?.repo).toBe('cursor/plugins');
    },
  );

  it('states a Version only when one is known: the vendor pin first, else the installed row', () => {
    expect(
      toCapabilityRows(resolveOne(definition(), [])).find((row) => row.id === 'version'),
    ).toBeUndefined();

    const clickup = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'clickup');
    if (!clickup) throw new Error('clickup definition missing');
    expect(
      toCapabilityRows(resolveOne(clickup, [])).find((row) => row.id === 'version')?.items,
    ).toEqual([{ id: 'version', label: '1.1.0' }]);

    const installed = resolveOne(definition(), [
      {
        id: 'inst',
        pluginId: 'test-plugin',
        sourceKind: 'frink_builtin',
        sourceLocator: null,
        installedVersion: '0.3.0',
        isInstalled: true,
        isEnabled: true,
      },
    ]);
    expect(toCapabilityRows(installed).find((row) => row.id === 'version')?.items[0]?.label).toBe(
      '0.3.0',
    );
  });

  it('counts an agent tool the same way the detail row lists them', () => {
    const shortcut = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'shortcut');
    if (!shortcut) throw new Error('shortcut definition missing');
    const plugin = resolveOne(shortcut, []);
    const listed = toCapabilityRows(plugin).find((row) => row.id === 'agent-tools')?.items.length;

    // Count the provider MCP alongside its curated actions and generic tool row.
    expect(capabilityCounts(plugin).agentTools).toBe(listed);
    expect(capabilityCounts(plugin).agentTools).toBe(7);
  });

  it('carries a trigger description and requirement through to its note', () => {
    const huggingface = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'huggingface');
    if (!huggingface) throw new Error('huggingface definition missing');
    const triggers = toCapabilityRows(resolveOne(huggingface, [])).find(
      (row) => row.id === 'triggers',
    );
    const any = triggers?.items.find((item) => item.id === 'huggingface.webhook_received');

    // Every mapping layer between EventSpec and this row hand-picks fields, so
    // a description silently vanishes if any layer drops it — this pins the
    // whole chain, catalog to rendered note.
    expect(any?.note).toContain('Runs for every event your Hugging Face webhook sends');
    expect(any?.note).toContain('choose what is sent');
  });

  it('prefers an action description over the generic kind label', () => {
    const clickup = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'clickup');
    if (!clickup) throw new Error('clickup definition missing');
    const tools = toCapabilityRows(resolveOne(clickup, [])).find((row) => row.id === 'agent-tools');

    expect(tools?.items.find((item) => item.id === 'clickup.get_task')?.note).toContain(
      'Reads a task and its details',
    );
  });

  it('leaves Shortcut write permissions to its vendor MCP annotations', () => {
    const shortcut = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'shortcut');
    if (!shortcut) throw new Error('shortcut definition missing');
    const rows = toCapabilityRows(resolveOne(shortcut, []));
    const tools = rows.find((row) => row.id === 'agent-tools');

    expect(tools?.items.find((item) => item.id === 'shortcut.create_story')?.writeRisk).toBe(false);
    expect(tools?.items.find((item) => item.id === 'shortcut')?.writeRisk).toBeFalsy();
  });

  it('badges only declared writes — a provider-MCP row that posts carries no write risk of its own', () => {
    const clickup = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'clickup');
    if (!clickup) throw new Error('clickup definition missing');
    const tools = toCapabilityRows(resolveOne(clickup, [])).find((row) => row.id === 'agent-tools');

    // The vendor server's own annotations govern an MCP row; only a Frink-versioned action declares `mutates`.
    expect(tools?.items.find((item) => item.id === 'clickup.create_task')?.writeRisk).toBe(false);
  });

  it('describes Shortcut actions and its MCP as tools for agents in chats and flows', () => {
    const shortcut = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === 'shortcut');
    if (!shortcut) throw new Error('shortcut definition missing');
    const tools = toCapabilityRows(resolveOne(shortcut, [])).find(
      (row) => row.id === 'agent-tools',
    );

    expect(tools?.items.find((item) => item.id === 'shortcut.create_story')?.note).toContain(
      'agents in chats and flows',
    );
    expect(tools?.items.find((item) => item.id === 'shortcut')?.note).toContain(
      'agents in chats and flows',
    );
  });

  it('describes the credential a builtin actually uses', () => {
    const rows = toCapabilityRows(resolveOne(CONNECTED_PLUGIN, []));
    expect(rows.find((row) => row.id === 'auth')?.items[0]).toMatchObject({
      label: 'Webhook secret',
      note: 'Required to use this plugin',
    });
  });

  it.each([
    ['neon', ['Browser sign-in']],
    ['posthog', ['Browser sign-in']],
    ['webflow', ['Browser sign-in']],
    ['linear', ['Webhook secret', 'Browser sign-in']],
    ['figma', ['Not available yet']],
  ])('describes every distinct account or tools grant for %s', (id, labels) => {
    const catalogEntry = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === id);
    if (!catalogEntry) throw new Error(`Missing plugin definition: ${id}`);
    const auth = toCapabilityRows(resolveOne(catalogEntry, [])).find((row) => row.id === 'auth');

    expect(auth?.items.map((item) => item.label)).toEqual(labels);
  });

  it.each(['webflow', 'posthog'])(
    'describes the single MCP grant that also sets up %s triggers',
    (id) => {
      const catalogEntry = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === id);
      if (!catalogEntry) throw new Error(`Missing plugin definition: ${id}`);
      const auth = toCapabilityRows(resolveOne(catalogEntry, [])).find((row) => row.id === 'auth');

      expect(auth?.items).toEqual([
        expect.objectContaining({ label: 'Browser sign-in', note: 'For tools and triggers' }),
      ]);
    },
  );

  it('gives every account its own item so a second one is never stranded', () => {
    const plugin = resolveOne(
      CONNECTED_PLUGIN,
      [],
      [
        { id: 'conn-1', providerId: 'test-plugin', accountName: 'Team A', isActive: true },
        { id: 'conn-2', providerId: 'test-plugin', accountName: 'Team B', isActive: true },
      ],
    );
    const selected: string[] = [];
    const accounts = toCapabilityRows(plugin, (id) => selected.push(id)).find(
      (row) => row.id === 'accounts',
    );

    expect(accounts?.items.map((item) => item.label)).toEqual(['Team A', 'Team B']);
    for (const item of accounts?.items ?? []) item.onSelect?.();
    expect(selected).toEqual(['conn-1', 'conn-2']);
  });

  it('treats an empty account name as absent, not as a blank label', () => {
    // Several connect inputs accept a bare `z.string().optional()`, so '' is
    // reachable. A `??` chain would keep it and render an empty row label on
    // one surface while another fell through to the identifier.
    expect(connectionLabel({ accountName: '', accountIdentifier: 'acct-1' })).toBe('acct-1');
    expect(connectionLabel({ accountName: null, accountIdentifier: '' })).toBe('Connected account');
  });

  it('leaves accounts inert when no management route is supplied', () => {
    const plugin = resolveOne(CONNECTED_PLUGIN, [], [TEST_ACCOUNT]);
    const accounts = toCapabilityRows(plugin).find((row) => row.id === 'accounts');

    expect(accounts?.items[0]?.onSelect).toBeUndefined();
  });

  it('omits Flow usage entirely rather than claiming a plugin is unused', () => {
    const rows = toCapabilityRows(resolveOne(definition(), [installation()]));

    // `plugins.list` never passes `bindings`, so the row could only ever assert
    // "not used in any Flow" — including about plugins a Flow really uses.
    expect(rows.find((row) => row.id === 'flows')).toBeUndefined();
  });
});

const CHAT_ONLY_PLUGIN = definition({
  id: 'wiki',
  source: { kind: 'frink_builtin' },
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
});

describe('chat-only plugins', () => {
  it.each([
    ['clickup', 'ClickUp'],
    ['shortcut', 'Shortcut'],
  ])('keeps %s connected before optional webhook setup', (id, name) => {
    const entry = PLUGIN_DEFINITIONS.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`${id} catalog entry missing`);
    const plugin = resolveOne(entry, []);
    expect(isChatOnlyPlugin(entry)).toBe(true);
    expect(resolvePluginStatus(plugin, 'connected').id).toBe('connected');
    expect(
      toCapabilityRows(plugin, undefined, 'connected').find((row) => row.id === 'accounts')
        ?.emptyCopy,
    ).toBe(`Connected to ${name}.`);
  });

  it('discloses a connected MCP account even when the vendor supplies no account identity', () => {
    const plugin = resolveOne(CHAT_ONLY_PLUGIN, []);
    const row = toCapabilityRows(plugin, undefined, 'connected').find(
      (item) => item.id === 'accounts',
    );
    expect(row?.items).toEqual([]);
    expect(row?.emptyCopy).toBe('Connected to Test Plugin.');
    for (const state of ['awaiting', 'none', 'unknown'] as const) {
      expect(
        toCapabilityRows(plugin, undefined, state).find((item) => item.id === 'accounts')
          ?.emptyCopy,
      ).toBe('No accounts connected.');
    }
  });

  it('is chat-only exactly when it declares an http server and no Flow provider', () => {
    expect(hasChatMcp(CHAT_ONLY_PLUGIN)).toBe(true);
    expect(isChatOnlyPlugin(CHAT_ONLY_PLUGIN)).toBe(true);
    expect(hasChatMcp(CONNECTED_PLUGIN)).toBe(false);
    expect(isChatOnlyPlugin(CONNECTED_PLUGIN)).toBe(false);
  });

  it('needs a connection until the tools grant exists, then reads plain Connected', () => {
    const plugin = resolveOne(CHAT_ONLY_PLUGIN, []);
    expect(resolvePluginStatus(plugin)).toMatchObject({ id: 'needs_connection' });
    expect(resolvePluginStatus(plugin, 'awaiting')).toMatchObject({
      id: 'needs_connection',
    });
    expect(resolvePluginStatus(plugin, 'connected')).toMatchObject({
      id: 'connected',
      label: 'Connected',
    });
  });

  it('offers Connect until the tools grant is live, with the one-sign-in line', () => {
    const plugin = resolveOne(CHAT_ONLY_PLUGIN, []);
    const awaiting = resolvePluginStatus(plugin, 'awaiting');
    expect(pluginConnectAction(plugin, awaiting, false, 'awaiting')).toMatchObject({
      label: 'Connect',
      placement: 'primary',
    });
    expect(connectSubline(plugin, 'awaiting')).toBe('One sign-in in your browser.');
    const connected = resolvePluginStatus(plugin, 'connected');
    expect(pluginConnectAction(plugin, connected, false)).toBeNull();
  });
});

/** Linear's shape: an http MCP server (tools) and a required Flow account. */
const TWO_GRANT_PLUGIN = definition({
  contents: {
    ...CHAT_ONLY_PLUGIN.contents,
    nativeExtensions: CONNECTED_PLUGIN.contents.nativeExtensions,
  },
});

/** GitHub's shape: the tools grant is a pasted token. */
const TOKEN_TWO_GRANT_PLUGIN = definition({
  contents: {
    ...TWO_GRANT_PLUGIN.contents,
    mcpServers: [
      {
        ...CHAT_ONLY_PLUGIN.contents.mcpServers[0]!,
        transport: {
          type: 'http',
          url: 'https://mcp.wiki.test/mcp',
          auth: {
            kind: 'user_token',
            setupUrl: 'https://wiki.test/tokens',
            validation: { url: 'https://wiki.test/me' },
          },
        },
      },
    ],
  },
});

const LIVE_ACCOUNT: ReadonlyArray<PluginConnection> = [TEST_ACCOUNT];
const NO_ACCOUNT: ReadonlyArray<PluginConnection> = [];

describe('connected means every declared grant', () => {
  const TWO_SIGN_INS = 'Two sign-ins in your browser.';
  const CHATS_LEG = 'One sign-in so chats can use Test Plugin.';
  const IN_MANAGE = 'Finish connecting in Manage.';
  const FINISH = 'Finish connecting';
  const INACTIVE_ACCOUNT: ReadonlyArray<PluginConnection> = [{ ...TEST_ACCOUNT, isActive: false }];

  it.each([
    ['awaiting', NO_ACCOUNT, 'needs_connection', 'Connect', TWO_SIGN_INS],
    [
      'connected',
      NO_ACCOUNT,
      'needs_connection',
      FINISH,
      `One sign-in so Test Plugin can notify Frink. ${IN_MANAGE}`,
    ],
    ['awaiting', LIVE_ACCOUNT, 'needs_connection', FINISH, `${CHATS_LEG} ${IN_MANAGE}`],
    // A pinned tools package that is not staged yet reads 'none': the consent is still owed.
    ['none', NO_ACCOUNT, 'needs_connection', 'Connect', TWO_SIGN_INS],
    ['none', LIVE_ACCOUNT, 'needs_connection', FINISH, `${CHATS_LEG} ${IN_MANAGE}`],
    // An account that is listed but not live still puts Manage on screen, so Connect joins it there.
    ['awaiting', INACTIVE_ACCOUNT, 'needs_connection', FINISH, `${TWO_SIGN_INS} ${IN_MANAGE}`],
    ['connected', LIVE_ACCOUNT, 'connected', null, null],
    ['unknown', LIVE_ACCOUNT, 'connected', null, null],
    // Placed only once the tools state settles: a live grant must not flash Connect before Manage.
    ['unknown', NO_ACCOUNT, 'needs_connection', null, null],
  ] as const)(
    'tools %s with accounts %o → %s, connect %s',
    (tools, connections, statusId, connectLabel, subline) => {
      const plugin = resolveOne(TWO_GRANT_PLUGIN, [installation()], connections);
      const status = resolvePluginStatus(plugin, tools);
      expect(status.id).toBe(statusId);
      const action = pluginConnectAction(plugin, status, false, tools);
      expect(action?.label ?? null).toBe(connectLabel);
      // Connect never sits beside Manage: once anything is connected it is Manage's first row.
      if (action) expect(action.placement).toBe(connectLabel === 'Connect' ? 'primary' : 'menu');
      expect(connectSubline(plugin, tools)).toBe(subline);
    },
  );

  it('a pasted-token tools grant is named as a paste, not a sign-in', () => {
    const nothing = resolveOne(TOKEN_TWO_GRANT_PLUGIN, [installation()]);
    expect(connectSubline(nothing, 'awaiting')).toBe('Paste a token, then one sign-in.');
    const accountOnly = resolveOne(TOKEN_TWO_GRANT_PLUGIN, [installation()], LIVE_ACCOUNT);
    expect(connectSubline(accountOnly, 'awaiting')).toBe(
      'Paste a token so chats can use Test Plugin. Finish connecting in Manage.',
    );
    expect(connectSubline(nothing, 'none')).toBe('Paste a token, then one sign-in.');
  });

  it('an account-only plugin gets no line under Connect', () => {
    expect(connectSubline(resolveOne(CONNECTED_PLUGIN, [installation()]), 'awaiting')).toBeNull();
  });

  it('a plugin with nothing to grant offers no Connect', () => {
    const plugin = resolveOne(definition(), [installation()]);
    expect(pluginConnectAction(plugin, resolvePluginStatus(plugin), false)).toBeNull();
  });
});
