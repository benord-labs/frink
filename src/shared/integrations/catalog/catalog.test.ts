import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { isVendorPluginMcpServer, vendorPluginMcpServerName } from '../../lib/mcp-tool-name';
import { PLUGIN_DEFINITIONS, type PluginMcpAuth } from '../plugins';
import { PROVIDERS } from '../providers';
import {
  CATALOG_MANIFEST_NAMES,
  catalogActions,
  catalogFlowHeaders,
  catalogIdentity,
  catalogMcpServers,
  MCP_PLUGIN_DEFINITIONS,
  parseCatalog,
} from './index';
import { manifestAvailability, pluginManifestSchema } from './manifest-schema';

/** The one auth kind the consent path completes today; frink_client joins with the SDK rewrite. */
const staticClient = { kind: 'static_client', clientId: 'client-1', callbackPort: 3119 } as const;

/** A standalone test vendor which cannot collide with a shipped trigger provider. */
const fixturewiki = {
  name: 'fixturewiki',
  displayName: 'Fixture Wiki',
  description: 'Pages and databases from your workspace',
  longDescription: 'Ask your chats to read the workspace you sign in to.',
  mcpServers: {
    fixturewiki: {
      type: 'http',
      url: 'https://mcp.fixturewiki.com/mcp',
      auth: { kind: 'frink_client' },
    },
  },
  frink: {},
} as const;

describe('catalog manifests on disk', () => {
  const folders = readdirSync(path.join(import.meta.dirname, '.'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('ships exactly the folders the loader imports (a dropped import is a silent missing plugin)', () => {
    expect(folders).toEqual([...CATALOG_MANIFEST_NAMES].sort());
  });

  it('retains Cursor attribution while exposing official destinations on standalone and builtin entries', () => {
    const mirrored = folders.filter((folder) => {
      const manifest = JSON.parse(
        readFileSync(path.join(import.meta.dirname, folder, 'plugin.json'), 'utf8'),
      );
      return manifest.frink.source?.repo === 'cursor/plugins';
    });
    expect(mirrored).toContain('profound');
    expect(mirrored).toContain('github');
    for (const id of mirrored) {
      const source = PLUGIN_DEFINITIONS.find((plugin) => plugin.id === id)?.sourceRef;
      expect(source?.repo, id).toBe('cursor/plugins');
      expect(source?.official?.url, id).toMatch(/^https:\/\//);
      expect(source?.official?.url, id).not.toContain('github.com/cursor/');
    }
  });

  it('puts every server, attachments included, under the plugin_ permission floor with a unique name', () => {
    const names = [
      ...MCP_PLUGIN_DEFINITIONS.flatMap((definition) =>
        definition.contents.mcpServers.map((server) =>
          vendorPluginMcpServerName(definition.id, server.id),
        ),
      ),
      ...PROVIDERS.flatMap((provider) =>
        catalogMcpServers(provider.id).map((server) =>
          vendorPluginMcpServerName(provider.id, server.id),
        ),
      ),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name !== null && isVendorPluginMcpServer(name)).toBe(true);
  });

  it('carries the manifest keywords onto the definition for directory search', () => {
    expect(PLUGIN_DEFINITIONS.find((d) => d.id === 'notion')?.keywords).toEqual([
      'notes',
      'wiki',
      'docs',
      'database',
    ]);
  });

  // Every manifest on disk goes through the schema; the two rules it cannot see are asserted here:
  // an action id is unique across the WHOLE catalog, and a label fits the palette's single line.
  it('keeps every curated row parseable, uniquely identified catalog-wide and short-labelled', () => {
    const seen = new Set<string>();
    for (const folder of folders) {
      const manifest = pluginManifestSchema.parse(
        JSON.parse(readFileSync(path.join(import.meta.dirname, folder, 'plugin.json'), 'utf8')),
      );
      for (const action of manifest.frink.actions ?? []) {
        expect(seen.has(action.id), `${folder}: ${action.id}`).toBe(false);
        seen.add(action.id);
        expect(action.label.length, `${folder}: ${action.id}`).toBeLessThanOrEqual(40);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('never restates the source vendor in user-facing copy', () => {
    for (const definition of MCP_PLUGIN_DEFINITIONS) {
      for (const copy of [
        definition.name,
        definition.description,
        definition.longDescription ?? '',
        ...(definition.beforeYouConnect ?? []),
      ]) {
        expect(copy).not.toMatch(/cursor/i);
      }
    }
  });
});

type ActionRow = {
  id: string;
  label: string;
  description: string;
  server: string;
  tool: string;
  icon?: string;
};
type IdentityOverlay = { server: string; tool: string; idPath: string };
type ActionOverlay = {
  flowHeaders?: Record<string, Record<string, string>>;
  identity?: IdentityOverlay;
};

describe('catalog actions', () => {
  it('preserves a curated operation preset through manifest parsing and catalog projection', () => {
    const preset = {
      inputPath: ['actions', 0, 'search'],
      fixedArgs: { actions: [{ label: 'search', search: {} }], context: 'Catalog-owned context' },
    };
    const parsed = parseCatalog([
      {
        ...fixturewiki,
        frink: {
          actions: [
            {
              id: 'fixturewiki.search',
              label: 'Search',
              description: 'Searches pages.',
              server: 'fixturewiki',
              tool: 'data_tool',
              preset,
            },
          ],
        },
      },
    ]);
    expect(parsed.standalone[0]?.contents.actions[0]?.source).toEqual({
      type: 'provider_mcp',
      serverId: 'fixturewiki',
      toolId: 'data_tool',
      preset,
    });
  });

  const withActions = (actions: ActionRow[] | undefined, overlay: ActionOverlay = {}) => ({
    ...fixturewiki,
    frink: { actions, ...overlay },
  });
  const row: ActionRow = {
    id: 'fixturewiki.search',
    label: 'L',
    description: 'D',
    tool: 'search',
    server: 'fixturewiki',
  };

  it('projects frink.actions onto provider_mcp rows and carries the Flow-side headers', () => {
    const parsed = parseCatalog([
      withActions(
        [
          {
            id: 'fixturewiki.search_pages',
            label: 'Search Fixture Wiki pages',
            icon: 'search',
            description: 'Finds pages by title.',
            server: 'fixturewiki',
            tool: 'search',
          },
        ],
        { flowHeaders: { fixturewiki: { 'x-mode': 'tools' } } },
      ),
    ]);
    expect(parsed.standalone[0]?.contents.actions).toEqual([
      {
        id: 'fixturewiki.search_pages',
        label: 'Search Fixture Wiki pages',
        icon: 'search',
        description: 'Finds pages by title.',
        source: { type: 'provider_mcp', serverId: 'fixturewiki', toolId: 'search' },
        schemaSource: 'mcp_tools_list',
      },
      {
        id: 'fixturewiki.call_tool',
        label: 'Call any Fixture Wiki tool',
        icon: 'wrench',
        description:
          'Runs any tool the Fixture Wiki server offers. Pick the tool, then fill in its arguments.',
        source: { type: 'provider_mcp', serverId: 'fixturewiki' },
        schemaSource: 'mcp_tools_list',
      },
    ]);
    expect(parsed.flowHeaders.get('fixturewiki/fixturewiki')).toEqual({ 'x-mode': 'tools' });
  });

  it('appends the generic call-tool row only where a connectable http server exists', () => {
    const pending = {
      ...fixturewiki,
      mcpServers: {
        fixturewiki: { ...fixturewiki.mcpServers.fixturewiki, auth: { kind: 'pending' } },
      },
    };
    expect(parseCatalog([pending], PROVIDERS, true).standalone[0]?.contents.actions).toEqual([]);
    const playwright = MCP_PLUGIN_DEFINITIONS.find((d) => d.id === 'playwright');
    expect(playwright?.contents.actions).toEqual([]);
    // A hyphenated plugin id still forms a legal node name (`my-wiki_call_tool`).
    const hyphenated = {
      ...fixturewiki,
      name: 'my-wiki',
      mcpServers: { 'my-wiki': fixturewiki.mcpServers.fixturewiki },
    };
    expect(
      parseCatalog([hyphenated], PROVIDERS, true).standalone[0]?.contents.actions.map((a) => a.id),
    ).toEqual(['my-wiki.call_tool']);
  });

  it.each([
    ['an id outside the plugin namespace', [{ ...row, id: 'other.search' }]],
    ['an undeclared server', [{ ...row, server: 'wiki' }]],
    ['a duplicate id', [row, row]],
    ['the reserved call_tool id', [{ ...row, id: 'fixturewiki.call_tool' }]],
  ])('rejects %s', (_label, actions) => {
    expect(() => parseCatalog([withActions(actions)])).toThrow();
  });

  it('carries a declared identity lookup, on the shipped rows too', () => {
    const identity: IdentityOverlay = {
      server: 'fixturewiki',
      tool: 'users-me',
      idPath: 'user.id',
    };
    expect(
      parseCatalog([withActions(undefined, { identity })]).identity.get('fixturewiki'),
    ).toEqual(identity);
    expect(catalogIdentity('shortcut')).toEqual({
      server: 'shortcut',
      tool: 'users-get-current',
      idPath: 'id',
    });
  });

  it.each([
    ['a server the manifest does not declare', { server: 'wiki', tool: 't', idPath: 'id' }],
    ['an empty tool name', { server: 'fixturewiki', tool: '', idPath: 'id' }],
    ['an unknown field', { server: 'fixturewiki', tool: 't', idPath: 'id', from: 'body' }],
  ])('rejects an identity lookup naming %s', (_label, identity) => {
    // SAFETY: each case deliberately supplies a malformed overlay for the parser to reject.
    expect(() =>
      parseCatalog([withActions(undefined, { identity: identity as IdentityOverlay })]),
    ).toThrow();
  });

  it('rejects flowHeaders for a server the manifest does not declare', () => {
    expect(() =>
      parseCatalog([withActions(undefined, { flowHeaders: { wiki: { 'x-mode': 'tools' } } })]),
    ).toThrow();
  });

  it("projects an attachment's actions under the provider name and appends its call_tool (sc-2793)", () => {
    const attachment = {
      name: 'linear',
      mcpServers: { linear: fixturewiki.mcpServers.fixturewiki },
      frink: {
        actions: [
          { id: 'linear.list', label: 'L', description: 'D', server: 'linear', tool: 'search' },
        ],
      },
    };
    expect(
      parseCatalog([attachment])
        .attachments.get('linear')
        ?.actions.map((a) => a.id),
    ).toEqual(['linear.list', 'linear.call_tool']);
    // A Coming soon attachment contributes no rows either: nothing could run them.
    const pending = {
      ...attachment,
      mcpServers: { linear: { ...fixturewiki.mcpServers.fixturewiki, auth: { kind: 'pending' } } },
    };
    expect(parseCatalog([pending]).attachments.get('linear')).toEqual({
      mcpServers: [],
      actions: [],
      keywords: [],
      beforeYouConnect: [],
    });
  });

  it('carries an attachment\'s keywords onto its builtin, so PostHog stays findable as "analytics"', () => {
    expect(PLUGIN_DEFINITIONS.find((d) => d.id === 'posthog')?.keywords).toEqual([
      'analytics',
      'feature flags',
      'product',
      'funnels',
    ]);
    expect(MCP_PLUGIN_DEFINITIONS.some((d) => d.id === 'posthog')).toBe(false);
  });

  it('gives the shipped attachments a call_tool over their http server, and a Coming soon row nothing', () => {
    for (const id of ['linear', 'clickup']) {
      const ids = catalogActions(id).map((a) => a.id);
      expect(ids.at(-1)).toBe(`${id}.call_tool`);
      for (const action of catalogActions(id)) {
        expect(action.source).toMatchObject({ type: 'provider_mcp', serverId: id });
      }
    }
    expect(catalogActions('canva')).toEqual([]);
  });

  it('sends posthog Flow probes and calls in tools mode, where its full tools/list lives', () => {
    expect(catalogFlowHeaders('posthog', 'posthog')).toEqual({ 'x-posthog-mcp-mode': 'tools' });
  });

  // A Coming soon row keeps its curated actions but withholds the generic call_tool row
  // (manifestActions, catalog/index.ts), so this only holds for connectable plugins.
  const curated = MCP_PLUGIN_DEFINITIONS.filter(
    (d) => d.availability === 'available' && d.contents.actions.length > 1,
  );
  it.each(curated.map((d) => [d.id, d] as const))(
    'ships every %s row over its own http server so the spawner can intersect it with tools/list',
    (id, definition) => {
      const ids = definition.contents.actions.map((a) => a.id);
      expect(ids.at(-1)).toBe(`${id}.call_tool`);
      for (const action of definition.contents.actions) {
        expect(action.source).toMatchObject({ type: 'provider_mcp', serverId: id });
      }
    },
  );
});

describe('parseCatalog', () => {
  it('composes a chat-only definition and honours the vendor-plugins kill switch', () => {
    const pendingFixtureWiki = {
      ...fixturewiki,
      mcpServers: {
        fixturewiki: { ...fixturewiki.mcpServers.fixturewiki, auth: { kind: 'pending' } },
      },
    };
    const listed = parseCatalog([pendingFixtureWiki], PROVIDERS, true).standalone[0];
    expect(listed).toMatchObject({
      id: 'fixturewiki',
      name: 'Fixture Wiki',
      icon: 'fixturewiki',
      keywords: [],
      source: { kind: 'frink_builtin' },
      availability: 'coming_soon',
    });
    // Listed only: the declared auth is withheld while the row is Coming soon.
    expect(listed?.contents.mcpServers[0]?.transport).toMatchObject({ auth: { kind: 'pending' } });
    expect(listed?.runtimeSupport['claude-code'].status).toBe('unsupported');
    const on = parseCatalog([fixturewiki], PROVIDERS, true).standalone[0];
    expect(on?.contents.mcpServers[0]?.transport).toMatchObject({ auth: { kind: 'frink_client' } });
    expect(on?.runtimeSupport['claude-code'].status).toBe('supported');
    expect(on?.runtimeSupport.codex.status).toBe('supported');
    const off = parseCatalog([fixturewiki], PROVIDERS, false).standalone[0];
    expect(off?.availability).toBe('disabled');
    expect(off?.runtimeSupport['claude-code'].status).toBe('unsupported');
    expect(off?.runtimeSupport.codex.status).toBe('unsupported');
  });

  it('requires the row copy on a standalone plugin', () => {
    expect(() =>
      parseCatalog(
        [{ name: 'fixturewiki', mcpServers: fixturewiki.mcpServers, frink: {} }],
        PROVIDERS,
      ),
    ).toThrow(/needs displayName/);
  });

  it('attaches servers to an existing provider by name and refuses restated copy', () => {
    const attachment = {
      name: 'linear',
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp', auth: { kind: 'frink_client' } },
      },
      frink: {},
    };
    const pending = {
      ...attachment,
      mcpServers: { linear: { ...attachment.mcpServers.linear, auth: { kind: 'pending' } } },
    };
    const parsed = parseCatalog([pending], PROVIDERS);
    expect(parsed.standalone).toEqual([]);
    // The provider row stays available, so a Coming soon attachment contributes no server at all.
    expect(parsed.attachments.get('linear')?.mcpServers).toEqual([]);
    expect(
      parseCatalog([attachment], PROVIDERS).attachments.get('linear')?.mcpServers[0],
    ).toMatchObject({
      id: 'linear',
      label: 'Linear',
      transport: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        auth: { kind: 'frink_client' },
      },
    });
    expect(() =>
      parseCatalog([{ ...attachment, description: 'Issue tracking' }], PROVIDERS),
    ).toThrow(/must not restate/);
  });

  it('rejects duplicate names, non-kebab server keys and pasted vendor keys', () => {
    expect(() => parseCatalog([fixturewiki, fixturewiki], PROVIDERS)).toThrow(
      /Duplicate catalog plugin/,
    );
    // The kebab-case key rule is what keeps plugin_<name>_<key> parseable as an mcp__ tool name.
    expect(() =>
      parseCatalog(
        [{ ...fixturewiki, mcpServers: { a_: fixturewiki.mcpServers.fixturewiki } }],
        PROVIDERS,
      ),
    ).toThrow(/kebab-case/);
    expect(() => parseCatalog([{ ...fixturewiki, logo: 'assets/logo.svg' }], PROVIDERS)).toThrow(
      /Unrecognized key/,
    );
    expect(() => parseCatalog([{ ...fixturewiki, author: { name: 'Cursor' } }], PROVIDERS)).toThrow(
      /Unrecognized key/,
    );
    expect(() =>
      parseCatalog(
        [
          {
            ...fixturewiki,
            frink: { auth: { fixturewiki: { kind: 'frink_client' } } },
          },
        ],
        PROVIDERS,
      ),
    ).toThrow(/Unrecognized key/);
  });

  it('derives availability: available only for http servers with auth the consent path delivers', () => {
    const parse = (manifest: z.input<typeof pluginManifestSchema>) =>
      manifestAvailability(pluginManifestSchema.parse(manifest));
    expect(parse(fixturewiki)).toBe('available');
    const userToken = {
      kind: 'user_token',
      setupUrl: 'https://x.test',
      validation: { url: 'https://x.test/me' },
    } as const;
    const withAuth = (auth: PluginMcpAuth) => ({
      ...fixturewiki,
      mcpServers: { fixturewiki: { ...fixturewiki.mcpServers.fixturewiki, auth } },
    });
    expect(parse(withAuth(userToken))).toBe('available');
    expect(parse(withAuth({ kind: 'pending' }))).toBe('coming_soon');
    // The status flag holds a row back for launch even though its own auth would deliver today.
    expect(parse({ ...fixturewiki, frink: { ...fixturewiki.frink, status: 'coming_soon' } })).toBe(
      'coming_soon',
    );
    expect(parse({ ...fixturewiki, mcpServers: { fixturewiki: { command: 'npx' } } })).toBe(
      'coming_soon',
    );
    expect(() =>
      pluginManifestSchema.parse({
        ...fixturewiki,
        mcpServers: {
          ...withAuth(userToken).mcpServers,
          second: fixturewiki.mcpServers.fixturewiki,
        },
      }),
    ).toThrow(/exactly one server/);
    // The deliverable set is injectable: a kind outside it is Coming soon even though the schema accepts it.
    const staticFixtureWiki = withAuth(staticClient);
    expect(parse(staticFixtureWiki)).toBe('available');
    expect(
      manifestAvailability(
        pluginManifestSchema.parse(staticFixtureWiki),
        new Set(['frink_client']),
      ),
    ).toBe('coming_soon');
  });

  it('never accepts an http server without auth, an empty server map or a loose source pin', () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...fixturewiki,
        mcpServers: { fixturewiki: { type: 'http', url: 'https://mcp.fixturewiki.com/mcp' } },
      }),
    ).toThrow();
    expect(() => pluginManifestSchema.parse({ ...fixturewiki, mcpServers: {} })).toThrow(
      /at least one/,
    );
    expect(() =>
      pluginManifestSchema.parse({
        ...fixturewiki,
        frink: {
          source: {
            repo: 'cursor/plugins',
            commit: 'zz',
            path: 'third_party/fixturewiki',
            license: 'MIT',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...fixturewiki,
        frink: {
          source: {
            repo: 'cursor/plugins',
            commit: '4612556',
            path: 'third_party/fixturewiki',
            license: 'Apache-2.0',
          },
        },
      }),
    ).toThrow();
  });

  it('keeps the row tagline within the one-line budget and requires https', () => {
    expect(() =>
      pluginManifestSchema.parse({ ...fixturewiki, description: 'x'.repeat(49) }),
    ).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...fixturewiki,
        mcpServers: {
          fixturewiki: {
            ...fixturewiki.mcpServers.fixturewiki,
            url: 'http://mcp.fixturewiki.com/mcp',
          },
        },
      }),
    ).toThrow();
  });
});

describe('beforeYouConnect', () => {
  const withNotes = (beforeYouConnect: ReadonlyArray<string>) => ({
    ...fixturewiki,
    frink: { beforeYouConnect },
  });

  it('takes one to three sentences and nothing longer or emptier', () => {
    const three = ['Be an admin.', 'Be on a paid plan.', 'Turn the toggle on.'];
    expect(pluginManifestSchema.parse(withNotes(three)).frink.beforeYouConnect).toEqual(three);
    expect(() => pluginManifestSchema.parse(withNotes([]))).toThrow();
    expect(() => pluginManifestSchema.parse(withNotes([...three, 'One too many.']))).toThrow();
    expect(() => pluginManifestSchema.parse(withNotes(['x'.repeat(201)]))).toThrow();
  });

  it('projects the manifest copy onto the standalone definition, and nothing onto a silent one', () => {
    const notes = ['Sign in as an admin.'];
    expect(parseCatalog([withNotes(notes)]).standalone[0]?.beforeYouConnect).toEqual(notes);
    expect(parseCatalog([fixturewiki]).standalone[0]?.beforeYouConnect).toEqual([]);
  });

  // Both catalog paths reach the plugin page: ashby is a standalone row, linear an
  // attachment whose copy has to survive the hop through the provider builtin.
  it('carries the shipped prerequisites onto both a standalone row and an attachment builtin', () => {
    expect(MCP_PLUGIN_DEFINITIONS.find((d) => d.id === 'ashby')?.beforeYouConnect?.[0]).toContain(
      'Opt-In Features',
    );
    expect(PLUGIN_DEFINITIONS.find((d) => d.id === 'linear')?.beforeYouConnect).toHaveLength(1);
  });
});

