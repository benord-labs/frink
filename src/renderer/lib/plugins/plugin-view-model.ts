/** Presentation model for the plugin capability surface: availability, live connections, the tools
 * grant and an explicit Turn off decide what the user is told. */
import type { BadgeVariant } from '@benord-labs/frink-primitives';
import type {
  PluginDefinition,
  PluginNativeExtension,
  PluginRuntime,
  PluginRuntimeDelivery,
  PluginSourceRef,
  ResolvedPlugin,
} from '../../../shared/integrations/plugins';
import { vendorPluginPin } from '../../../shared/integrations/vendor-plugin-pins';
import { mcpAuthItems, mcpSuppliesTriggerCredential } from './plugin-detail-model';

// No caller imports this by name — every consumer reaches it through the
// `status.id` field on `PluginStatus`, which is exported.
type PluginStatusId =
  | 'coming_soon'
  | 'unavailable'
  // User-facing toggle (installation.isEnabled=false) — distinct from
  // definition.availability 'disabled', which is the launch gate ('unavailable').
  | 'disabled'
  | 'needs_connection'
  | 'connected';

export type PluginStatus = {
  id: PluginStatusId;
  label: string;
  tone: BadgeVariant;
};

function status(id: PluginStatusId, label: string, tone: BadgeVariant): PluginStatus {
  return { id, label, tone };
}

function requiresConnection(plugin: ResolvedPlugin): boolean {
  return plugin.definition.contents.nativeExtensions.some(
    (extension) => extension.kind === 'frink_provider' && extension.connection.required,
  );
}

/** Declares an http MCP server Frink delivers to chats — the surface the chat grant and its status belong to. */
export function hasChatMcp(definition: PluginDefinition): boolean {
  return definition.contents.mcpServers.some((server) => server.transport.type === 'http');
}

/** The token grant of the first server connected by a pasted token, if the plugin declares one. */
export function userTokenAuth(definition: PluginDefinition) {
  for (const { transport } of definition.contents.mcpServers) {
    if (transport.type === 'http' && transport.auth.kind === 'user_token') return transport.auth;
  }
  return undefined;
}

/** Whether installation alone is insufficient to make this plugin usable. */
export function pluginNeedsGrant(plugin: ResolvedPlugin): boolean {
  return requiresConnection(plugin) || hasChatMcp(plugin.definition);
}

/** A row whose Connect is the chat grant alone: no Flow account is owed (PostHog's endpoint row is minted later, from its Triggers card). */
export function isChatOnlyPlugin(definition: PluginDefinition): boolean {
  return (
    hasChatMcp(definition) &&
    !definition.contents.nativeExtensions.some(
      (extension) => extension.kind === 'frink_provider' && extension.connection.required,
    )
  );
}

/** The plugin's tools grant as the live status poll reports it; 'unknown' until that query settles. */
export type PluginToolsState = 'connected' | 'awaiting' | 'none' | 'unknown';

/** Nothing outranks these: an unshipped plugin nobody has installed (an existing install keeps its
 * real state so it stays openable and removable), then the user's explicit Turn off. */
function overridingStatus(plugin: ResolvedPlugin): PluginStatus | null {
  if (
    plugin.definition.availability === 'coming_soon' &&
    plugin.installation?.isInstalled !== true
  ) {
    return status('coming_soon', 'Coming soon', 'default');
  }
  // Connected must not mask a plugin the user turned off; its accounts stay manageable via the row.
  if (plugin.installation?.isInstalled === true && plugin.installation.isEnabled === false) {
    return status('disabled', 'Turned off', 'default');
  }
  return null;
}

/** A settled missing package or grant requires connection; a webhook record cannot authenticate tools. */
function toolsMissing(definition: PluginDefinition, tools: PluginToolsState): boolean {
  return hasChatMcp(definition) && (tools === 'awaiting' || tools === 'none');
}

/** The sign-ins still owed once nothing outranks them, from the grants the plugin declares. */
function grantStatus(plugin: ResolvedPlugin, tools: PluginToolsState): PluginStatus {
  const toolsDeclared = hasChatMcp(plugin.definition);
  const accountRequired = requiresConnection(plugin);
  // A tools-only plugin has no account to wait for: its grant alone decides.
  if (toolsDeclared && !accountRequired && tools === 'connected') {
    return status('connected', 'Connected', 'success');
  }
  // A tools grant needs its sign-in as much as a Flow provider needs an account.
  if (pluginNeedsGrant(plugin) || !plugin.installation?.isInstalled) {
    return status('needs_connection', 'Needs connection', 'warning');
  }
  return status('connected', 'Connected', 'success');
}

/** Availability first, then the live grants; never keyed off `lifecycle`, which would badge a live
 * account "Not installed". Connected means EVERY declared grant, and Turn off overrides both. */
export function resolvePluginStatus(
  plugin: ResolvedPlugin,
  tools: PluginToolsState = 'unknown',
): PluginStatus {
  const overriding = overridingStatus(plugin);
  if (overriding) return overriding;
  // A confirmed account outranks the launch flag: it exists, and the directory lists it so it
  // stays readable and disconnectable after its provider is turned off.
  const live = plugin.connections.some((connection) => connection.isActive);
  if (live && !toolsMissing(plugin.definition, tools)) {
    return status('connected', 'Connected', 'success');
  }
  if (plugin.definition.availability === 'disabled') {
    return status('unavailable', 'Unavailable', 'default');
  }
  return grantStatus(plugin, tools);
}

// No caller imports this by name — every consumer reaches it through
// `PluginCapabilityRow.items`, which is exported.
type PluginCapabilityItem = {
  id: string;
  label: string;
  note?: string;
  /** Marks an action that stays inert until the user grants it explicitly. */
  writeRisk?: boolean;
  /** Present when the item is individually manageable, e.g. a connected account. */
  onSelect?: () => void;
  /** An external page the item points at, opened in the system browser. */
  href?: string;
  hrefLabel?: string;
  /** A runtime's delivery facts; absent from every non-runtime item. */
  delivers?: PluginRuntimeDelivery;
};

export type PluginCapabilityRow = {
  id: string;
  label: string;
  items: PluginCapabilityItem[];
  /** Shown instead of the items. A row never disappears — see toCapabilityRows. */
  emptyCopy: string;
};

const RUNTIME_LABELS: Record<PluginRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

function sourceLabel(kind: PluginDefinition['source']['kind']): string {
  return kind === 'frink_builtin' ? 'Frink built-in' : 'Agent Plugins v1';
}

/** The package at its exact pinned revision; a manifest's `path` narrows a monorepo to the plugin's folder. */
export function pluginSourceUrl(ref: PluginSourceRef): string {
  const tree = `https://github.com/${ref.repo}/tree/${ref.commit}`;
  return ref.path ? `${tree}/${ref.path}` : tree;
}

/** The pin is the shipped truth for a vendor package; an installed row's version covers everything else. */
function pluginVersion(plugin: ResolvedPlugin): string | null {
  return (
    vendorPluginPin(plugin.definition.id)?.version ?? plugin.installation?.installedVersion ?? null
  );
}

/** Lets the detail pane hand each connected account its own management route. */
export type SelectAccount = (connectionId: string) => void;

type ProviderExtension = Extract<PluginNativeExtension, { kind: 'frink_provider' }>;

function providerExtensions(plugin: ResolvedPlugin): ProviderExtension[] {
  return plugin.definition.contents.nativeExtensions.filter(
    (extension): extension is ProviderExtension => extension.kind === 'frink_provider',
  );
}

function authRow(plugin: ResolvedPlugin): PluginCapabilityRow {
  return {
    id: 'auth',
    label: 'Auth',
    items: [
      ...(mcpSuppliesTriggerCredential(plugin)
        ? []
        : providerExtensions(plugin).map((extension) => ({
            id: extension.id,
            label: 'Webhook secret',
            note: extension.connection.required ? 'Required to use this plugin' : 'Optional',
          }))),
      ...mcpAuthItems(plugin),
    ],
    emptyCopy: 'No account needed.',
  };
}

/**
 * The one place a connection's display label is decided.
 *
 * `accountName` is `string | null` and several connect inputs accept a bare
 * `z.string().optional()`, so an empty string is reachable. It must be treated
 * as absent — a `??` chain here would render a blank label on one surface while
 * another fell through to the identifier for the same connection.
 */
export function connectionLabel(connection: {
  accountName?: string | null;
  accountIdentifier?: string | null;
}): string {
  return connection.accountName || connection.accountIdentifier || 'Connected account';
}

/** The one description of a plugin's connect affordance. `null` means render no button and the caller
 * may not substitute one: a gated provider must not be offered a connect Frink would refuse. */
export type PluginConnectAction = {
  label: string;
  ariaLabel: string;
  /** 'menu' once anything is connected: Manage is then on screen, and Connect never sits beside it. */
  placement: 'primary' | 'menu';
};

/** Anything connected, live or not, puts Manage on screen — the same evidence its menu reads. */
function connectPlacement(plugin: ResolvedPlugin, tools: PluginToolsState) {
  return plugin.connections.length > 0 || tools === 'connected' ? 'menu' : 'primary';
}

export function pluginConnectAction(
  plugin: ResolvedPlugin,
  status: PluginStatus,
  isConnecting: boolean,
  tools: PluginToolsState = 'unknown',
): PluginConnectAction | null {
  if (plugin.definition.availability !== 'available') return null;
  // A turned-off plugin offers no connect path — turning it back on is the
  // gesture that resumes it, not adding another account.
  if (status.id === 'disabled') return null;
  if (status.id === 'connected') return null;
  const { name } = plugin.definition;
  const placement = connectPlacement(plugin, tools);
  // Placed once the tools state settles, so a live grant never shows Connect and then swaps it for Manage.
  if (placement === 'primary' && hasChatMcp(plugin.definition) && tools === 'unknown') return null;
  // Deliberately "Connect", never "Reconnect": this button mints a fresh
  // connect session, and true in-place re-auth rides the reconnect
  // coordinator, whose completion the browser flow cannot yet observe.
  // Claiming reconnection here would be false.
  const verb = placement === 'menu' ? 'Finish connecting' : 'Connect';
  return {
    label: isConnecting ? 'Connecting' : verb,
    ariaLabel: `${verb} ${name}`,
    placement,
  };
}

/** Whether example prompts can run in chat (every declared grant live); `null` until the tools state settles. */
export function promptsUnlocked(plugin: ResolvedPlugin, tools: PluginToolsState): boolean | null {
  const { definition } = plugin;
  const liveAccount = plugin.connections.some((connection) => connection.isActive);
  if (!hasChatMcp(definition)) return liveAccount;
  if (tools === 'unknown') return null;
  return tools === 'connected' && (isChatOnlyPlugin(definition) || liveAccount);
}

const ONE_SIGN_IN = 'One sign-in in your browser.';

/** The sign-ins the chain will still run, from the declared grants and what is missing; `null` when none is owed. */
function missingLegs(plugin: ResolvedPlugin, tools: PluginToolsState): string | null {
  const { definition } = plugin;
  const accountMissing =
    requiresConnection(plugin) && !plugin.connections.some((connection) => connection.isActive);
  const byToken = userTokenAuth(definition) !== undefined;
  // A tools package that is pinned but not staged yet reads 'none': its consent is still owed, like 'awaiting'.
  if (tools === 'connected') {
    return accountMissing ? `One sign-in so ${definition.name} can notify Frink.` : null;
  }
  if (accountMissing) {
    return byToken ? 'Paste a token, then one sign-in.' : 'Two sign-ins in your browser.';
  }
  if (plugin.connections.length === 0) return byToken ? 'Paste a token.' : ONE_SIGN_IN;
  // Something already works, so name what the missing grant adds.
  return byToken
    ? `Paste a token so chats can use ${definition.name}.`
    : `One sign-in so chats can use ${definition.name}.`;
}

/** The line under the header's actions, naming where the fix is once Connect lives in Manage; `null` while the tools state is unknown, and for an account-only plugin. */
export function connectSubline(plugin: ResolvedPlugin, tools: PluginToolsState): string | null {
  if (tools === 'unknown' || !hasChatMcp(plugin.definition)) return null;
  const legs = missingLegs(plugin, tools);
  if (!legs || connectPlacement(plugin, tools) === 'primary') return legs;
  return `${legs} Finish connecting in Manage.`;
}

function accountsRow(
  plugin: ResolvedPlugin,
  onSelectAccount: SelectAccount | undefined,
  tools: PluginToolsState,
): PluginCapabilityRow {
  return {
    id: 'accounts',
    label: 'Accounts',
    items: plugin.connections.map((connection) => ({
      id: connection.id,
      label: connectionLabel(connection),
      note: connection.isActive ? undefined : 'Inactive',
      ...(onSelectAccount ? { onSelect: () => onSelectAccount(connection.id) } : {}),
    })),
    emptyCopy:
      hasChatMcp(plugin.definition) && tools === 'connected'
        ? `Connected to ${plugin.definition.name}.`
        : 'No accounts connected.',
  };
}

/** Counts provider MCPs and deterministic actions consistently with the Tools row. */
export function capabilityCounts(plugin: ResolvedPlugin): { triggers: number; agentTools: number } {
  const { mcpServers, actions, triggers } = plugin.definition.contents;
  return { triggers: triggers.length, agentTools: mcpServers.length + actions.length };
}

function agentToolsRow(plugin: ResolvedPlugin): PluginCapabilityRow {
  const { mcpServers, actions } = plugin.definition.contents;
  return {
    id: 'agent-tools',
    label: 'Tools',
    items: [
      ...mcpServers.map((server) => ({
        id: server.id,
        label: server.label,
        // The one capability class that reaches agents in everyday chats.
        note: 'Provider MCP · agents in chats and flows',
      })),
      ...actions.map((action) => ({
        id: action.id,
        label: action.label,
        // Requirement rides in the same note (the triggers-row pattern), and the
        // surface suffix says where the tool runs so the page never overclaims:
        // a provider-MCP action reaches agents wherever its server is registered.
        note: `${[
          action.description ??
            (action.schemaSource === 'frink_versioned' ? 'Frink action' : 'Provider MCP'),
          action.requirement,
        ]
          .filter(Boolean)
          .join(
            ' ',
          )} · ${action.source.type === 'deterministic_flow' ? 'Flow step' : 'agents in chats and flows'}`,
        // Write risk is declared per action — read ops must not badge as writes.
        writeRisk: action.schemaSource === 'frink_versioned' && action.mutates,
      })),
    ],
    emptyCopy: 'No tools in this plugin.',
  };
}

function triggersRow(plugin: ResolvedPlugin): PluginCapabilityRow {
  return {
    id: 'triggers',
    label: 'Triggers',
    items: plugin.definition.contents.triggers.map((trigger) => ({
      id: trigger.id,
      label: trigger.label,
      // Requirement rides in the same note: a trigger that needs provider-side
      // setup must say so where the trigger is read, not in a far-away doc.
      note: [trigger.description, trigger.requirement].filter(Boolean).join(' ') || undefined,
    })),
    emptyCopy: 'No triggers in this plugin.',
  };
}

/** Delivery facts per runtime; the note carries prose only where a runtime gets nothing. */
function worksInRow(plugin: ResolvedPlugin): PluginCapabilityRow {
  const runtimes = Object.keys(RUNTIME_LABELS) as PluginRuntime[];
  return {
    id: 'works-in',
    label: 'Works in',
    items: runtimes.map((runtime) => {
      const support = plugin.runtimeSupport[runtime];
      return {
        id: runtime,
        label: RUNTIME_LABELS[runtime],
        note: support.status === 'unsupported' ? support.reason : undefined,
        delivers: support.delivers,
      };
    }),
    emptyCopy: 'No runtime can load this plugin yet.',
  };
}

function sourceRow(plugin: ResolvedPlugin): PluginCapabilityRow {
  const { source, sourceRef } = plugin.definition;
  const item: PluginCapabilityItem = { id: source.kind, label: sourceLabel(source.kind) };
  if (sourceRef?.official) {
    item.href = sourceRef.official.url;
    item.hrefLabel =
      sourceRef.official.kind === 'plugin' ? 'Official plugin' : 'Official documentation';
  } else if (sourceRef) item.href = pluginSourceUrl(sourceRef);
  return { id: 'source', label: 'Source', items: [item], emptyCopy: 'Unknown source.' };
}

/** A fact, not a capability: with no version anywhere the row is absent rather than stated empty. */
function versionRow(plugin: ResolvedPlugin): PluginCapabilityRow | null {
  const version = pluginVersion(plugin);
  if (!version) return null;
  return {
    id: 'version',
    label: 'Version',
    items: [{ id: 'version', label: version }],
    emptyCopy: 'Unknown version.',
  };
}

/**
 * Every row is returned even when empty. An omitted capability reads as
 * portability the plugin does not have, so absence is stated rather than
 * implied — the empty copy is the honest half of this surface.
 */
export function toCapabilityRows(
  plugin: ResolvedPlugin,
  onSelectAccount?: SelectAccount,
  tools: PluginToolsState = 'unknown',
): PluginCapabilityRow[] {
  const { skills } = plugin.definition.contents;
  const version = versionRow(plugin);
  return [
    sourceRow(plugin),
    ...(version ? [version] : []),
    authRow(plugin),
    accountsRow(plugin, onSelectAccount, tools),
    {
      id: 'skills',
      label: 'Skills',
      items: skills.map((skill) => ({ id: skill.id, label: skill.name, note: skill.description })),
      emptyCopy: 'No skills in this plugin.',
    },
    agentToolsRow(plugin),
    triggersRow(plugin),
    worksInRow(plugin),
  ];
}
