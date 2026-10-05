import { useStore } from 'jotai';
import { type RefObject, useEffect, useId, useRef } from 'react';
import type { ResolvedPlugin } from '../../../../../shared/integrations/plugins';
import {
  bandChain,
  capabilityRowsInTier,
  bandPrompts,
  mcpSuppliesTriggerCredential,
} from '../../../../lib/plugins/plugin-detail-model';
import {
  capabilityCounts,
  pluginConnectAction,
  promptsUnlocked,
  resolvePluginStatus,
  toCapabilityRows,
} from '../../../../lib/plugins/plugin-view-model';
import { usePluginChatGrant } from '../../../../lib/plugins/use-plugin-chat-grant';
import { usePluginFlowLaunch } from '../../../../lib/plugins/use-plugin-flow-launch';
import { useWebhookEndpointSetup } from '../../../../lib/plugins/use-webhook-endpoint-setup';
import { PluginCapabilitySection, REFERENCE_HEADING } from '../../PluginCapabilitySection';
import { PluginChatConsentDialog } from '../../PluginChatConsentDialog';
import { PluginTriggerBand } from '../../PluginTriggerBand';
import { CapabilityTier } from '../CapabilityTier';
import { PluginDetailSkeleton } from '../PluginDetailSkeleton';
import { type PluginActions, PluginPageHeader } from '../PluginPageHeader';
import { PluginTokenDialog } from '../PluginTokenDialog';
import { PluginTriggers } from '../PluginTriggers';

type Props = {
  plugin?: ResolvedPlugin;
  isLoading: boolean;
  isError: boolean;
} & PluginActions;

/**
 * Top-down: what this is, what it starts, the inventories a user acts on, then
 * the reference facts. Every row renders even when empty — an omitted row reads
 * as a capability the plugin has and we failed to list.
 */
export function PluginBody({
  plugin,
  isLoading,
  isError,
  isConnecting,
  onConnect,
  onSelectAccount,
}: Props) {
  const launchFlow = usePluginFlowLaunch();
  const store = useStore();
  // One live poll for the page: the status badge, Connect and the prompts all read it.
  const grant = usePluginChatGrant(plugin?.definition, onConnect);
  const endpointSetup = useWebhookEndpointSetup(plugin, grant.granted);
  // Where the tools grant IS the trigger credential, "try again" re-runs that consent.
  const usesMcpSetup =
    plugin !== undefined &&
    plugin.definition.provider?.subscription === 'auto' &&
    mcpSuppliesTriggerCredential(plugin) &&
    grant.chatOnly &&
    !grant.tokenAuth;
  const prerequisiteId = useId();
  // Ticket for in-flight prompt seeds: a newer click supersedes an older one,
  // and unmount (leaving this page for ANY destination) invalidates them all.
  const seedRequest = useRef(0);
  useEffect(
    () => () => {
      seedRequest.current = -1;
    },
    [],
  );

  if (isLoading) return <PluginDetailSkeleton />;

  // "The catalogue could not be read" and "this plugin is not in it" call for different next steps.
  if (isError) {
    return <p className="text-muted-fg text-sm">Plugin capabilities are unavailable right now.</p>;
  }
  if (!plugin) {
    return <p className="text-muted-fg text-sm">This provider has no plugin package.</p>;
  }

  // Resolved here, not in the header: Connect and the prerequisite sentence are one answer.
  const status = resolvePluginStatus(plugin, grant.chat.state);
  const connecting = isConnecting || grant.chat.isEnabling;
  const connect = pluginConnectAction(plugin, status, connecting, grant.chat.state);
  // Prerequisites are owed only while the sign-in they gate is; "Add another" past Connected is not it.
  const prerequisites =
    connect && status.id !== 'connected' ? plugin.definition.beforeYouConnect : undefined;
  const rows = toCapabilityRows(plugin, onSelectAccount, grant.chat.state);
  const liveAccount = plugin.connections.find((connection) => connection.isActive);
  // For a chat-only plugin the tools grant is what a prompt runs on: a webhook account alone
  // never unlocks it, and a locked click runs that grant.
  const prompts = promptsUnlocked(plugin, grant.chat.state);
  const { onUseInFlow, onUsePrompt } = bandHandlers(
    {
      plugin,
      liveAccount,
      onConnect: grant.connect,
      // A Flow needs the endpoint row, so wherever this machine can mint one "Use in Flow" mints it.
      onConnectForFlow: endpointSetup.offered ? endpointSetup.create : grant.connect,
      flowRoutable: Boolean(liveAccount) || grant.granted,
      prompts,
    },
    launchFlow,
    store,
    seedRequest,
  );

  return (
    <div>
      <PluginPageHeader
        plugin={plugin}
        chat={grant.chat}
        onChatGrant={grant.run}
        status={status}
        connect={connect}
        connecting={connecting}
        describedBy={prerequisites?.length ? prerequisiteId : undefined}
        onSelectAccount={onSelectAccount}
      />

      <PluginTriggerBand
        pluginName={plugin.definition.name}
        chain={bandChain(plugin)}
        triggerCount={plugin.definition.contents.triggers.length}
        agentToolCount={capabilityCounts(plugin).agentTools}
        chatToolsAvailable={plugin.definition.contents.mcpServers.length > 0}
        onUseInFlow={onUseInFlow}
        prompts={bandPrompts(plugin)}
        onUsePrompt={onUsePrompt}
        promptsLocked={prompts === false}
      />

      <PluginTriggers
        plugin={plugin}
        endpointSetup={endpointSetup}
        onRetrySetup={usesMcpSetup ? () => grant.chat.enable({ reconnect: true }) : undefined}
        retryingSetup={grant.chat.isEnabling}
      />
      <PackageParagraph plugin={plugin} />
      {/* The precondition read with the description, not crowded against the button it gates. */}
      {prerequisites?.length ? (
        <p id={prerequisiteId} className="mt-3 max-w-[68ch] text-base text-dim leading-relaxed">
          {prerequisites.join(' ')}
        </p>
      ) : null}
      <AccountsAndInventory rows={rows} accountFirst={liveAccount !== undefined || grant.granted} />

      <ReferenceTier rows={rows} />
      <TokenGrantDialog plugin={plugin} grant={grant} />
      <PluginChatConsentDialog
        id={plugin.definition.id}
        name={plugin.definition.name}
        chat={grant.chat}
        onRetry={grant.run}
      />
    </div>
  );
}

/** The one token dialog on the page; absent for plugins granted by a browser consent. */
function TokenGrantDialog({
  plugin,
  grant,
}: {
  plugin: ResolvedPlugin;
  grant: ReturnType<typeof usePluginChatGrant>;
}) {
  if (!grant.tokenAuth) return null;
  return (
    <PluginTokenDialog
      pluginId={plugin.definition.id}
      name={plugin.definition.name}
      auth={grant.tokenAuth}
      open={grant.tokenOpen}
      onOpenChange={grant.setTokenOpen}
      onConnected={grant.onTokenSaved}
    />
  );
}

/** The package's own paragraph; absent only for an imported package that ships none, which gets silence over a placeholder. */
function PackageParagraph({ plugin }: { plugin: ResolvedPlugin }) {
  if (!plugin.definition.longDescription) return null;
  return (
    <p className="mt-7 max-w-[68ch] text-base text-muted-fg leading-relaxed">
      {plugin.definition.longDescription}
    </p>
  );
}

/** Accounts leads only once there is one to manage — re-ordered, never hidden. */
function AccountsAndInventory({
  rows,
  accountFirst,
}: {
  rows: ReturnType<typeof toCapabilityRows>;
  accountFirst: boolean;
}) {
  const accounts = <CapabilityTier rows={capabilityRowsInTier(rows, 'accounts')} />;
  const inventory = (
    <CapabilityTier rows={capabilityRowsInTier(rows, 'inventory')} variant="chips" />
  );
  return accountFirst ? (
    <>
      {accounts}
      {inventory}
    </>
  ) : (
    <>
      {inventory}
      {accounts}
    </>
  );
}

/**
 * The reference tier on its own surface (`bg-raised`), listed like an app store entry: Information
 * (the facts about the package), then Works in (what each runtime loads from it).
 */
function ReferenceTier({ rows }: { rows: ReturnType<typeof toCapabilityRows> }) {
  return (
    <div className="mt-16 rounded-2xl bg-raised px-6 py-7">
      <section>
        <h2 className={REFERENCE_HEADING}>Information</h2>
        <dl className="mt-2.5 space-y-1.5">
          {capabilityRowsInTier(rows, 'fact').map((row) => (
            <PluginCapabilitySection key={row.id} row={row} variant="fact" />
          ))}
        </dl>
      </section>
      {capabilityRowsInTier(rows, 'matrix').map((row) => (
        <div key={row.id} className="mt-7">
          <PluginCapabilitySection row={row} variant="matrix" />
        </div>
      ))}
    </div>
  );
}

type BandActionDeps = {
  plugin: ResolvedPlugin;
  liveAccount: ResolvedPlugin['connections'][number] | undefined;
  onConnect: (pluginId: string) => void;
  /** What "Use in Flow" runs without a Flow account: the connect chain, or the endpoint mint where that is the account. */
  onConnectForFlow: (pluginId: string) => void;
  /** A live Flow account, or the chat grant of a chat-only plugin. */
  flowRoutable: boolean;
  /** Whether a prompt can run in chat; `null` while that is still unsettled. */
  prompts: boolean | null;
};

// A gated provider (not yet authorizable) gets no handler on a band action it
// cannot run: that action routes to Connect, and that Connect would be refused.
function bandHandlers(
  deps: BandActionDeps,
  launchFlow: ReturnType<typeof usePluginFlowLaunch>,
  store: ReturnType<typeof useStore>,
  seedRequest: RefObject<number>,
) {
  // Turned-off is paused — no flow launches or chat seeds until re-enabled; never-installed still routes to Connect.
  const enabled = deps.plugin.installation?.isEnabled !== false;
  const available = deps.plugin.definition.availability === 'available';
  // An unsettled prompt gets no handler: a neutral example, never a lock it may then lift.
  const promptRoutable = enabled && deps.prompts !== null && (deps.prompts || available);
  return {
    onUseInFlow:
      enabled && (deps.flowRoutable || available) ? makeUseInFlow(deps, launchFlow) : undefined,
    onUsePrompt: promptRoutable ? makeUsePrompt(deps, store, seedRequest) : undefined,
  };
}

// "Use in Flow" needs a real connection id for the webhook trigger, so with no
// account the click routes to Connect.
function makeUseInFlow(
  { plugin, liveAccount, onConnectForFlow }: BandActionDeps,
  launchFlow: ReturnType<typeof usePluginFlowLaunch>,
) {
  return (triggerId: string) => {
    if (!liveAccount) {
      onConnectForFlow(plugin.definition.id);
      return;
    }
    const trigger = plugin.definition.contents.triggers.find(
      (candidate) => candidate.id === triggerId,
    );
    if (!trigger) return;
    launchFlow({
      pluginName: plugin.definition.name,
      trigger,
      connectionId: liveAccount.id,
    });
  };
}

// A locked prompt cannot run, so the click routes to Connect —
// the same never-dead-end contract Use in Flow keeps. Seeding uses a deferred
// import (the agents barrel carries the whole chat surface; a static import
// would drag it into everything that renders the detail page).
function makeUsePrompt(
  { plugin, prompts, onConnect }: BandActionDeps,
  store: ReturnType<typeof useStore>,
  seedRequest: RefObject<number>,
) {
  return (prompt: string) => {
    if (!prompts) {
      onConnect(plugin.definition.id);
      return;
    }
    const requestId = ++seedRequest.current;
    agentsChunk ??= import('@/features/agents');
    void agentsChunk
      .then(({ seedNewChatPromptAtom }) => {
        if (seedRequest.current !== requestId) return;
        store.set(seedNewChatPromptAtom, prompt);
      })
      .catch(() => {
        // One failed chunk load must not stay cached and poison every later click.
        agentsChunk = null;
      });
  };
}

/** The deferred agents barrel (heavy chunk), loaded once per renderer no matter how many prompts are clicked. */
let agentsChunk: Promise<typeof import('@/features/agents')> | null = null;
