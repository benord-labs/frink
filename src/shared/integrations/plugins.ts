/**
 * Canonical plugin catalog and lifecycle selectors.
 *
 * A plugin is the installable package. It may contain provider-native MCP
 * servers, skills, runtime-native extensions, Frink extensions, triggers, and
 * deterministic fallback actions. Installation, account connection, Flow
 * binding, and authority are deliberately separate axes.
 */
import type { McpToolPreset } from '../lib/flows/mcp-tool-preset';
import { LAUNCH_FLAGS } from '../launch-flags';
import {
  builtinActions,
  catalogBeforeYouConnect,
  catalogKeywords,
  catalogMcpServers,
  catalogSource,
  MCP_PLUGIN_DEFINITIONS,
} from './catalog';
import type { PluginMcpAuth, PluginSourceRef } from './catalog/manifest-schema';
import type { CustomNodeIconKey } from '../lib/custom-node-icon-allowlist';
import type { ManifestOutputField } from '../lib/output-schemas';
import { catalogRuntimeSupport, VENDOR_INVENTORIES } from './vendor-inventory';
import { PROVIDERS } from './providers';
import { providerConnection } from './selectors';
import type { Provider } from './types';
import type { PluginRuntime, PluginRuntimeSupportMatrix } from './plugin-runtime-support';
import { VENDOR_PLUGIN_CONTENTS, vendorPluginSource } from './vendor-plugin-pins';

export type { PluginSourceRef } from './catalog/manifest-schema';
export type { PluginRuntime, PluginRuntimeDelivery } from './plugin-runtime-support';

type PluginSourceKind = 'frink_builtin' | 'agent_plugins_v1';
type PluginSource =
  | { kind: 'frink_builtin'; providerId?: string }
  | { kind: 'agent_plugins_v1'; manifestVersion: '1'; locator?: string };

type PluginMcpTransport =
  | { type: 'stdio'; command: string; args?: ReadonlyArray<string> }
  | { type: 'http'; url: string; auth: PluginMcpAuth };
export type { PluginMcpAuth };

export interface PluginMcpServer {
  id: string;
  label: string;
  /** The installed package owns the provider tool contract. */
  ownership: 'provider_native';
  /** tools/list is the field source; annotations are never authority. */
  schemaSource: 'mcp_tools_list';
  transport: PluginMcpTransport;
  connectionBinding:
    | { type: 'none' }
    | { type: 'frink_selected_connection'; providerExtensionId: string };
}

export interface PluginSkill {
  id: string;
  name: string;
  path: string;
  description?: string;
}

export type PluginNativeExtension =
  | {
      id: string;
      kind: 'runtime_native';
      runtime: PluginRuntime;
      path: string;
    }
  | {
      id: string;
      kind: 'frink_provider';
      providerId: string;
      /** Flow graphs persist the immutable connection ID, never this label. */
      flowBinding: 'connection_id';
      connection: { required: boolean };
    };

export interface PluginTrigger {
  id: string;
  label: string;
  /** What fires it, carried through from the provider's EventSpec. */
  description?: string;
  /** Provider-side setup it needs before it can fire. */
  requirement?: string;
  filterFieldIds: ReadonlyArray<string>;
  source: { type: 'provider_event'; providerId: string; eventId: string };
}

/** Flat form-field shape shared with custom-node manifests (SchemaFields renders it). */
export type PluginActionInput = {
  type?: string;
  required?: boolean;
  default?: unknown;
  label?: string;
  placeholder?: string;
};

/** Identity every catalog action row carries, whatever supplies its input schema. */
type PluginActionBase = {
  id: string;
  label: string;
  /** What the action does, phrased for the plugin detail page and its Flow step. */
  description?: string;
  /** Provider-side setup it needs before it can run. */
  requirement?: string;
  /** Curated glyph for the node palette and canvas card. */
  icon?: CustomNodeIconKey;
};

export type PluginAction =
  | (PluginActionBase & {
      source: { type: 'provider_mcp'; serverId: string; toolId?: string; preset?: McpToolPreset };
      schemaSource: 'mcp_tools_list';
    })
  | (PluginActionBase & {
      /** Declared write intent — drives the approval badge and permission class. */
      mutates: boolean;
      source: { type: 'deterministic_flow'; operationId: string; schemaVersion: string };
      schemaSource: 'frink_versioned';
      /**
       * What the op's projected response carries — spawned nodes surface these
       * as {{previous.*}} hints so a read op's payload is addressable downstream.
       */
      outputs?: Readonly<Record<string, ManifestOutputField>>;
      /**
       * Frink-owned versioned form fields (deterministic ops never derive from a
       * provider schema; authoring the node IS the grant — decision
       * frink-mcp-tool-permission-trust 2026-08-18).
       */
      inputs: Readonly<Record<string, PluginActionInput>>;
    });

export interface PluginPackageContents {
  mcpServers: ReadonlyArray<PluginMcpServer>;
  skills: ReadonlyArray<PluginSkill>;
  nativeExtensions: ReadonlyArray<PluginNativeExtension>;
  triggers: ReadonlyArray<PluginTrigger>;
  actions: ReadonlyArray<PluginAction>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  /** The detail page's paragraph. Optional: an `agent_plugins_v1` manifest need not carry one. */
  longDescription?: string;
  icon: string;
  /** Directory search aliases from the catalog manifest ("twitter" finds X). */
  keywords?: ReadonlyArray<string>;
  /** Vendor prerequisites — a role, a plan, an admin toggle — stated before the sign-in they gate. */
  beforeYouConnect?: ReadonlyArray<string>;
  source: PluginSource;
  /** Absent for a builtin with no external package behind it. */
  sourceRef?: PluginSourceRef;
  /** Builtins retain the registry object instead of copying provider facts. */
  provider?: Provider;
  availability: Provider['status'] | 'disabled';
  contents: PluginPackageContents;
  runtimeSupport: PluginRuntimeSupportMatrix;
}

export interface PluginInstallationSnapshot {
  id: string;
  pluginId: string;
  sourceKind: PluginSourceKind;
  sourceLocator: string | null;
  installedVersion: string | null;
  isInstalled: boolean;
  isEnabled: boolean;
}

export interface PluginConnection {
  id: string;
  providerId: string;
  accountName?: string | null;
  accountIdentifier?: string | null;
  isActive: boolean;
}

interface PluginFlowBinding {
  pluginId: string;
  connectionId: string;
  flowId: string;
  isActive: boolean;
}

interface PluginGrant {
  pluginId: string;
  connectionId: string;
  capabilityId: string;
  isActive: boolean;
}

type PluginInstallationState = 'not_installed' | 'disabled' | 'enabled';
type PluginConnectionState = 'not_required' | 'needs_connection' | 'connected';
type PluginLifecycle =
  | 'not_installed'
  | 'disabled'
  | 'needs_connection'
  | 'installed'
  | 'connected';

export interface ResolvedPlugin {
  definition: PluginDefinition;
  installation: PluginInstallationSnapshot | null;
  installationState: PluginInstallationState;
  connectionState: PluginConnectionState;
  connections: ReadonlyArray<PluginConnection>;
  bindings: ReadonlyArray<PluginFlowBinding>;
  grants: ReadonlyArray<PluginGrant>;
  lifecycle: PluginLifecycle;
  runtimeSupport: PluginRuntimeSupportMatrix;
}

export interface ResolvePluginsInput {
  definitions?: ReadonlyArray<PluginDefinition>;
  installations: ReadonlyArray<PluginInstallationSnapshot>;
  /** Every account is held on this machine, so this list is the whole truth. */
  connections?: ReadonlyArray<PluginConnection>;
  bindings?: ReadonlyArray<PluginFlowBinding>;
  grants?: ReadonlyArray<PluginGrant>;
}

function builtinContents(provider: Provider): PluginPackageContents {
  const vendor = VENDOR_PLUGIN_CONTENTS[provider.id];
  const skills = VENDOR_INVENTORIES[provider.id]?.skills ?? [];
  const mcpServers = [...(vendor?.mcpServers ?? []), ...catalogMcpServers(provider.id)];
  return {
    mcpServers,
    skills,
    nativeExtensions: [
      ...(vendor?.nativeExtensions ?? []),
      {
        id: `frink.provider.${provider.id}`,
        kind: 'frink_provider',
        providerId: provider.id,
        flowBinding: 'connection_id',
        connection: providerConnection(mcpServers, skills.length > 0),
      },
    ],
    triggers: provider.events.map((event) => ({
      id: `${provider.id}.${event.id}`,
      label: event.label,
      description: event.description,
      requirement: event.requirement,
      filterFieldIds: event.filter_field_ids,
      source: { type: 'provider_event', providerId: provider.id, eventId: event.id },
    })),
    actions: builtinActions(provider, mcpServers, builtinAvailability(provider)),
  };
}

function builtinAvailability(provider: Provider): PluginDefinition['availability'] {
  if (provider.status === 'coming_soon') return 'coming_soon';
  if (provider.enabled_when?.some((flag) => LAUNCH_FLAGS[flag] !== true)) return 'disabled';
  return 'available';
}

function builtinDefinition(provider: Provider): PluginDefinition {
  const contents = builtinContents(provider);
  const definition: PluginDefinition = {
    id: provider.id,
    name: provider.display_name,
    description: provider.description,
    longDescription: provider.long_description,
    icon: provider.icon,
    keywords: catalogKeywords(provider.id),
    beforeYouConnect: catalogBeforeYouConnect(provider.id),
    source: { kind: 'frink_builtin', providerId: provider.id },
    provider,
    availability: builtinAvailability(provider),
    contents,
    runtimeSupport: catalogRuntimeSupport(provider.id, contents),
  };
  const source = vendorPluginSource(provider.id) ?? catalogSource(provider.id);
  if (source) definition.sourceRef = source;
  return definition;
}

/** Builtins derive from the provider registry; chat-only plugins from catalog/ data folders. */
export const PLUGIN_DEFINITIONS: ReadonlyArray<PluginDefinition> = [
  ...PROVIDERS.map(builtinDefinition),
  ...MCP_PLUGIN_DEFINITIONS,
];

export function getPluginDefinition(id: string): PluginDefinition | undefined {
  return PLUGIN_DEFINITIONS.find((plugin) => plugin.id === id);
}

function installationState(
  installation: PluginInstallationSnapshot | undefined,
): PluginInstallationState {
  if (!installation?.isInstalled) return 'not_installed';
  return installation.isEnabled ? 'enabled' : 'disabled';
}

function connectionState(
  providerExtensions: ReadonlyArray<Extract<PluginNativeExtension, { kind: 'frink_provider' }>>,
  connections: ReadonlyArray<PluginConnection>,
): PluginConnectionState {
  const requiredProviderIds = new Set(
    providerExtensions
      .filter((extension) => extension.connection.required)
      .map((extension) => extension.providerId),
  );
  if (requiredProviderIds.size === 0) return 'not_required';
  const active = connections.filter((connection) => connection.isActive);
  return [...requiredProviderIds].every((id) => active.some((row) => row.providerId === id))
    ? 'connected'
    : 'needs_connection';
}

function lifecycle(
  installState: PluginInstallationState,
  connectState: PluginConnectionState,
): PluginLifecycle {
  if (installState === 'not_installed') return 'not_installed';
  if (installState === 'disabled') return 'disabled';
  if (connectState === 'needs_connection') return 'needs_connection';
  if (connectState === 'connected') return 'connected';
  return 'installed';
}

export function resolvePlugins({
  definitions = PLUGIN_DEFINITIONS,
  installations,
  connections: connectionRows = [],
  bindings = [],
  grants = [],
}: ResolvePluginsInput): ReadonlyArray<ResolvedPlugin> {
  const definitionIds = new Set<string>();
  for (const definition of definitions) {
    if (definitionIds.has(definition.id)) {
      throw new Error(`Duplicate plugin definition id: ${definition.id}`);
    }
    definitionIds.add(definition.id);

    const providerExtensionIds = new Set(
      definition.contents.nativeExtensions
        .filter((extension) => extension.kind === 'frink_provider')
        .map((extension) => extension.id),
    );
    for (const server of definition.contents.mcpServers) {
      if (
        server.connectionBinding.type === 'frink_selected_connection' &&
        !providerExtensionIds.has(server.connectionBinding.providerExtensionId)
      ) {
        throw new Error(
          `Plugin ${definition.id} MCP ${server.id} references unknown provider extension ${server.connectionBinding.providerExtensionId}`,
        );
      }
    }
  }

  return definitions.map((definition) => {
    const installation = installations.find(
      (row) => row.pluginId === definition.id && row.sourceKind === definition.source.kind,
    );
    const providerExtensions = definition.contents.nativeExtensions.filter(
      (extension): extension is Extract<PluginNativeExtension, { kind: 'frink_provider' }> =>
        extension.kind === 'frink_provider',
    );
    const providerIds = new Set(providerExtensions.map((extension) => extension.providerId));
    const connections = connectionRows.filter((row) => providerIds.has(row.providerId));
    const pluginBindings = bindings.filter((row) => row.pluginId === definition.id);
    const pluginGrants = grants.filter((row) => row.pluginId === definition.id);
    const installState = installationState(installation);
    const connectState = connectionState(providerExtensions, connections);

    return {
      definition,
      installation: installation ?? null,
      installationState: installState,
      connectionState: connectState,
      connections,
      bindings: pluginBindings,
      grants: pluginGrants,
      lifecycle: lifecycle(installState, connectState),
      runtimeSupport: definition.runtimeSupport,
    };
  });
}
