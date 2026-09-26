import { VENDOR_PLUGIN_CONTENTS, vendorPluginSource } from '../vendor-plugin-pins';
/** Data-file catalog: the static import list below IS the curated allowlist (frink-integration-plugin 2026-09-01 Target). */
import { LAUNCH_FLAGS } from '../../launch-flags';
import { catalogRuntimeSupport, VENDOR_INVENTORIES } from '../vendor-inventory';
import type {
  PluginAction,
  PluginDefinition,
  PluginMcpServer,
  PluginPackageContents,
  PluginSourceRef,
} from '../plugins';
import { PROVIDERS } from '../providers';
import type { Provider } from '../types';
import {
  CALL_TOOL_ACTION,
  httpServerKeys,
  manifestAvailability,
  type PluginIdentityLookup,
  type PluginManifest,
  pluginManifestSchema,
} from './manifest-schema';
import amplemarket from './amplemarket/plugin.json';
import asana from './asana/plugin.json';
import ashby from './ashby/plugin.json';
import atlassian from './atlassian/plugin.json';
import canva from './canva/plugin.json';
import circleback from './circleback/plugin.json';
import clay from './clay/plugin.json';
import clickup from './clickup/plugin.json';
import cloudflare from './cloudflare/plugin.json';
import context7 from './context7/plugin.json';
import docusign from './docusign/plugin.json';
import figma from './figma/plugin.json';
import github from './github/plugin.json';
import gong from './gong/plugin.json';
import googleCalendar from './google-calendar/plugin.json';
import googleDrive from './google-drive/plugin.json';
import hubspot from './hubspot/plugin.json';
import huggingface from './huggingface/plugin.json';
import intercom from './intercom/plugin.json';
import juicebox from './juicebox/plugin.json';
import linear from './linear/plugin.json';
import navan from './navan/plugin.json';
import neon from './neon/plugin.json';
import notion from './notion/plugin.json';
import outreach from './outreach/plugin.json';
import paypal from './paypal/plugin.json';
import playwright from './playwright/plugin.json';
import posthog from './posthog/plugin.json';
import profound from './profound/plugin.json';
import sentry from './sentry/plugin.json';
import shortcut from './shortcut/plugin.json';
import square from './square/plugin.json';
import supabase from './supabase/plugin.json';
import vercel from './vercel/plugin.json';
import webflow from './webflow/plugin.json';
import x from './x/plugin.json';
import zoom from './zoom/plugin.json';

const RAW_MANIFESTS: ReadonlyArray<unknown> = [
  amplemarket,
  asana,
  ashby,
  atlassian,
  canva,
  circleback,
  clay,
  clickup,
  cloudflare,
  context7,
  docusign,
  figma,
  github,
  gong,
  googleCalendar,
  googleDrive,
  hubspot,
  huggingface,
  intercom,
  juicebox,
  linear,
  navan,
  neon,
  notion,
  outreach,
  paypal,
  playwright,
  posthog,
  profound,
  sentry,
  shortcut,
  square,
  supabase,
  vercel,
  webflow,
  x,
  zoom,
];

type FlowHeaders = Readonly<Record<string, string>>;
/** What a data folder contributes to a builtin: its servers, the Flow rows over them and its search aliases. */
type CatalogAttachment = Pick<PluginPackageContents, 'mcpServers' | 'actions'> & {
  keywords: ReadonlyArray<string>;
  beforeYouConnect: ReadonlyArray<string>;
  sourceRef?: PluginSourceRef;
};
const EMPTY_ATTACHMENT: CatalogAttachment = {
  mcpServers: [],
  actions: [],
  keywords: [],
  beforeYouConnect: [],
};

type ParsedCatalog = {
  standalone: ReadonlyArray<PluginDefinition>;
  attachments: ReadonlyMap<string, CatalogAttachment>;
  /** `<plugin>/<server>` → headers that ride Flow-side probes and calls only. */
  flowHeaders: ReadonlyMap<string, FlowHeaders>;
  /** Plugin id → the tool call that reads back the signed-in user's vendor id. */
  identity: ReadonlyMap<string, PluginIdentityLookup>;
};

/** A Coming soon row lists its servers with `pending` auth — never connectable until Frink can deliver its auth. */
function manifestServers(manifest: PluginManifest, label: string): PluginMcpServer[] {
  const listedOnly = manifestAvailability(manifest) !== 'available';
  return Object.entries(manifest.mcpServers).map(([key, server]) => ({
    id: key,
    label,
    ownership: 'provider_native',
    schemaSource: 'mcp_tools_list',
    transport:
      'url' in server
        ? { type: 'http', url: server.url, auth: listedOnly ? { kind: 'pending' } : server.auth }
        : { type: 'stdio', command: server.command, args: server.args },
    connectionBinding: { type: 'none' },
  }));
}

/**
 * The one generic "call any tool" row over an http server — minted here only, so the reserved
 * `call_tool` suffix never comes from a hand-written literal (frink-integration-plugin 2026-09-07).
 */
function callToolAction(pluginId: string, displayName: string, serverId: string): PluginAction {
  return {
    id: `${pluginId}.${CALL_TOOL_ACTION}`,
    label: `Call any ${displayName} tool`,
    description: `Runs any tool the ${displayName} server offers. Pick the tool, then fill in its arguments.`,
    icon: 'wrench',
    source: { type: 'provider_mcp', serverId },
    schemaSource: 'mcp_tools_list',
  };
}

/** Curated Flow nodes over the manifest's http servers, then the generic call-tool row while the row is connectable. */
function manifestActions(manifest: PluginManifest, displayName: string): PluginAction[] {
  const rows: PluginAction[] = (manifest.frink.actions ?? []).map((action) => {
    const row: PluginAction = {
      id: action.id,
      label: action.label,
      description: action.description,
      source: action.preset
        ? {
            type: 'provider_mcp',
            serverId: action.server,
            toolId: action.tool,
            preset: action.preset,
          }
        : { type: 'provider_mcp', serverId: action.server, toolId: action.tool },
      schemaSource: 'mcp_tools_list',
    };
    if (action.icon) row.icon = action.icon;
    return row;
  });
  const [serverId] = httpServerKeys(manifest);
  if (serverId !== undefined && manifestAvailability(manifest) === 'available') {
    rows.push(callToolAction(manifest.name, displayName, serverId));
  }
  return rows;
}

function manifestContents(manifest: PluginManifest, displayName: string): CatalogAttachment {
  return {
    mcpServers: manifestServers(manifest, displayName),
    actions: manifestActions(manifest, displayName),
    keywords: manifest.frink.keywords ?? [],
    beforeYouConnect: manifest.frink.beforeYouConnect ?? [],
    sourceRef: manifest.frink.source,
  };
}

function standaloneDefinition(
  manifest: PluginManifest,
  vendorPluginsEnabled: boolean,
): PluginDefinition {
  const { displayName, description, longDescription } = manifest;
  if (!displayName || !description || !longDescription) {
    throw new Error(
      `Catalog plugin ${manifest.name} needs displayName, description and longDescription.`,
    );
  }
  const { keywords, beforeYouConnect, sourceRef, ...attachment } = manifestContents(
    manifest,
    displayName,
  );
  const contents = {
    ...attachment,
    skills: VENDOR_INVENTORIES[manifest.name]?.skills ?? [],
    triggers: [],
    nativeExtensions: VENDOR_PLUGIN_CONTENTS[manifest.name]?.nativeExtensions ?? [],
  };
  const definition: PluginDefinition = {
    id: manifest.name,
    name: displayName,
    description,
    longDescription,
    icon: manifest.name,
    keywords,
    beforeYouConnect,
    source: { kind: 'frink_builtin' },
    // The vendor-plugin kill switch: off means no chat delivery, so nothing to connect.
    availability: vendorPluginsEnabled ? manifestAvailability(manifest) : 'disabled',
    contents,
    runtimeSupport: catalogRuntimeSupport(manifest.name, contents, vendorPluginsEnabled),
  };
  const source = vendorPluginSource(manifest.name) ?? sourceRef;
  if (source) definition.sourceRef = source;
  return definition;
}

/** Pure so tests can feed fixture manifests; the module constants below feed the shipped list. */
export function parseCatalog(
  raw: ReadonlyArray<unknown>,
  providers: ReadonlyArray<Provider> = PROVIDERS,
  vendorPluginsEnabled: boolean = LAUNCH_FLAGS.vendorClaudePlugins,
): ParsedCatalog {
  const names = new Set<string>();
  const standalone: PluginDefinition[] = [];
  const attachments = new Map<string, CatalogAttachment>();
  const flowHeaders = new Map<string, FlowHeaders>();
  const identity = new Map<string, PluginIdentityLookup>();
  for (const entry of raw) {
    const manifest = pluginManifestSchema.parse(entry);
    if (names.has(manifest.name)) throw new Error(`Duplicate catalog plugin: ${manifest.name}`);
    names.add(manifest.name);
    for (const [server, headers] of Object.entries(manifest.frink.flowHeaders ?? {})) {
      flowHeaders.set(`${manifest.name}/${server}`, headers);
    }
    if (manifest.frink.identity) identity.set(manifest.name, manifest.frink.identity);
    const provider = providers.find((candidate) => candidate.id === manifest.name);
    if (!provider) {
      standalone.push(standaloneDefinition(manifest, vendorPluginsEnabled));
      continue;
    }
    if (manifest.displayName || manifest.description || manifest.longDescription) {
      throw new Error(`Catalog attachment ${manifest.name} must not restate the provider's copy.`);
    }
    // A Coming soon attachment contributes no server or Flow row until Frink can connect it.
    // Keywords are search aliases rather than capability, so they still ride along.
    attachments.set(
      manifest.name,
      manifestAvailability(manifest) === 'available'
        ? manifestContents(manifest, provider.display_name)
        : {
            ...EMPTY_ATTACHMENT,
            keywords: manifest.frink.keywords ?? [],
            sourceRef: manifest.frink.source,
          },
    );
  }
  return { standalone, attachments, flowHeaders, identity };
}

const CATALOG = parseCatalog(RAW_MANIFESTS);

/** Every manifest folder the loader imports, standalone or attachment — the folders-vs-imports test keys on it. */
export const CATALOG_MANIFEST_NAMES: ReadonlyArray<string> = [
  ...CATALOG.standalone.map((definition) => definition.id),
  ...CATALOG.attachments.keys(),
];

/** Chat-only plugins composed from data folders (no trigger Provider behind them). */
export const MCP_PLUGIN_DEFINITIONS: ReadonlyArray<PluginDefinition> = CATALOG.standalone;

/** Servers a data folder attaches to an existing builtin: its chat tools beside the builtin's triggers. */
export function catalogMcpServers(providerId: string): ReadonlyArray<PluginMcpServer> {
  return (CATALOG.attachments.get(providerId) ?? EMPTY_ATTACHMENT).mcpServers;
}

/** Flow rows a data folder attaches to an existing builtin, its call_tool included (sc-2793). */
export function catalogActions(providerId: string): ReadonlyArray<PluginAction> {
  return (CATALOG.attachments.get(providerId) ?? EMPTY_ATTACHMENT).actions;
}

/** Package provenance and vendor links for manifests attached to a builtin provider. */
export function catalogSource(providerId: string): PluginSourceRef | undefined {
  return CATALOG.attachments.get(providerId)?.sourceRef;
}

/** Directory search aliases a data folder attaches to an existing builtin. */
export function catalogKeywords(providerId: string): ReadonlyArray<string> {
  return (CATALOG.attachments.get(providerId) ?? EMPTY_ATTACHMENT).keywords;
}

/** Vendor prerequisites a data folder attaches to an existing builtin, stated before its Connect runs (sc-2600). */
export function catalogBeforeYouConnect(providerId: string): ReadonlyArray<string> {
  return (CATALOG.attachments.get(providerId) ?? EMPTY_ATTACHMENT).beforeYouConnect;
}

/** A builtin's Flow rows: the curated ones, its data folder's, then one generated call_tool over its
 * http server, and only while the row is connectable. */
export function builtinActions(
  provider: Provider,
  mcpServers: ReadonlyArray<PluginMcpServer>,
  availability: PluginDefinition['availability'],
): ReadonlyArray<PluginAction> {
  const rows = [...catalogActions(provider.id)];
  const http = mcpServers.find((server) => server.transport.type === 'http');
  const callToolId = `${provider.id}.${CALL_TOOL_ACTION}`;
  if (http && availability === 'available' && !rows.some((row) => row.id === callToolId)) {
    rows.push(callToolAction(provider.id, provider.display_name, http.id));
  }
  return availability === 'available' ? rows : rows.filter((row) => row.id !== callToolId);
}

/** The identity lookup a plugin declares, standalone or attached to a builtin; absent = Frink cannot learn who signed in. */
export function catalogIdentity(pluginId: string): PluginIdentityLookup | undefined {
  return CATALOG.identity.get(pluginId);
}

/** Headers a Flow-side probe or call adds for one server; chat delivery never sees them. */
export function catalogFlowHeaders(pluginId: string, serverId: string): FlowHeaders | undefined {
  return CATALOG.flowHeaders.get(`${pluginId}/${serverId}`);
}
