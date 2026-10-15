import { useAtom } from 'jotai';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { agentModelFamilies } from '@/lib/ai-providers/chat-options';
import { cn } from '@/lib/utils';
import { LAUNCH_FLAGS } from '../../../../../../shared/launch-flags';
import {
  AI_PROVIDERS,
  type AiProviderId,
  selectableProviderIds,
} from '../../../../../../shared/lib/ai-providers';
import {
  CLAUDE_MODEL_FAMILIES,
  CODEX_MODEL_FAMILIES,
  splitNewestFamilies,
} from '../../../../../../shared/lib/models';
import { hiddenModelsAtom } from '../../../../../lib/atoms';
import { trpc } from '../../../../../lib/trpc';
import { AccountsErrorBanner } from '../../../../ui/accounts-error-banner';
import { Switch } from '../../../../ui/switch';
import { ProviderTile } from '../ProviderTile';

type Family = { id: string; name: string };

const CATALOG = {
  'claude-code': CLAUDE_MODEL_FAMILIES,
  codex: CODEX_MODEL_FAMILIES,
} satisfies Record<string, readonly Family[]>;
type CatalogProvider = keyof typeof CATALOG;
type ToggleModel = (provider: AiProviderId, families: readonly Family[], family: Family) => void;

type Props = {
  /** When false, show the Claude and OpenAI catalogs (avoids an empty flash while accounts load). */
  authGateReady: boolean;
  /** Provider ids with a signed-in account. */
  connected: string[];
  /** After fetch completed with an error; catalog stays ungated until retry succeeds. */
  accountsListFailed?: boolean;
  onRetryAccounts?: () => void;
};

function ModelRow({
  family,
  on,
  onToggle,
}: {
  family: Family;
  on: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className={cn('text-sm', on ? 'text-foreground' : 'text-muted-foreground')}>
        {family.name}
      </span>
      <Switch checked={on} onCheckedChange={onToggle} aria-label={`Show ${family.name}`} />
    </li>
  );
}

function isCatalogProvider(provider: AiProviderId): provider is CatalogProvider {
  return Object.hasOwn(CATALOG, provider);
}

function ProviderModels({
  provider,
  families,
  fold,
  hidden,
  onToggle,
  empty,
}: {
  provider: AiProviderId;
  families: readonly Family[];
  /** Fold older models behind a toggle; agents list every model. */
  fold: boolean;
  hidden: string[];
  onToggle: ToggleModel;
  /** Shown in place of the rows when there are none. */
  empty?: string;
}): ReactElement {
  const { newest, older } = fold ? splitNewestFamilies(families) : { newest: families, older: [] };
  // Start open when the only models left on are older ones, so they can be seen.
  const [showOlder, setShowOlder] = useState(() => newest.every((f) => hidden.includes(f.id)));
  const row = (family: Family) => (
    <ModelRow
      key={family.id}
      family={family}
      on={!hidden.includes(family.id)}
      onToggle={() => onToggle(provider, families, family)}
    />
  );
  return (
    <div className="pb-2">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1">
        <ProviderTile type={provider} size="sm" />
        <span className="text-sm font-medium text-foreground">{AI_PROVIDERS[provider].name}</span>
      </div>
      <ul>
        {newest.map(row)}
        {showOlder ? older.map(row) : null}
      </ul>
      {families.length === 0 && empty ? (
        <p className="px-4 py-2.5 text-sm text-muted-foreground">{empty}</p>
      ) : null}
      {older.length > 0 ? (
        <button
          type="button"
          aria-expanded={showOlder}
          onClick={() => setShowOlder(!showOlder)}
          className="mx-2 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', showOlder && 'rotate-180')}
            aria-hidden
          />
          {showOlder ? 'Hide older models' : `Show ${older.length} older models`}
        </button>
      ) : null}
    </div>
  );
}

/** An installed agent's group: the models it last reported, read from the picker's own query. */
function AgentModels({
  agentId,
  hidden,
  onToggle,
}: {
  agentId: AiProviderId;
  hidden: string[];
  onToggle: ToggleModel;
}): ReactElement {
  const { data, isPending } = trpc.agentAccounts.models.useQuery({ type: agentId });
  return (
    <ProviderModels
      provider={agentId}
      families={agentModelFamilies(agentId, data ?? [])}
      fold={false}
      hidden={hidden}
      onToggle={onToggle}
      empty={
        isPending
          ? undefined
          : `Start a chat with ${AI_PROVIDERS[agentId].name} to see its models here.`
      }
    />
  );
}

export function ModelsSection({
  authGateReady,
  connected,
  accountsListFailed = false,
  onRetryAccounts,
}: Props) {
  const [hiddenModels, setHiddenModels] = useAtom(hiddenModelsAtom);

  // Until accounts load, show the Claude and OpenAI catalogs rather than flashing an empty card.
  const providers = selectableProviderIds(LAUNCH_FLAGS, window.desktopApi?.platform).filter((p) =>
    authGateReady ? connected.includes(p) : isCatalogProvider(p),
  );

  const toggleModel: ToggleModel = (provider, families, family) => {
    if (hiddenModels.includes(family.id)) {
      setHiddenModels(hiddenModels.filter((id) => id !== family.id));
      return;
    }
    const othersOn = families.some((f) => f.id !== family.id && !hiddenModels.includes(f.id));
    if (!othersOn) {
      toast.info(`Keep at least one ${AI_PROVIDERS[provider].name} model on.`);
      return;
    }
    setHiddenModels([...hiddenModels, family.id]);
  };

  return (
    <SettingsCard>
      {accountsListFailed ? (
        <AccountsErrorBanner
          message="Could not load accounts. Claude and OpenAI models are shown until this works."
          onRetry={onRetryAccounts}
        />
      ) : null}
      {providers.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Add an account above to choose its models.
        </p>
      ) : (
        <div className="divide-y divide-border/50">
          {providers.map((p) =>
            isCatalogProvider(p) ? (
              <ProviderModels
                key={p}
                provider={p}
                families={CATALOG[p]}
                fold
                hidden={hiddenModels}
                onToggle={toggleModel}
              />
            ) : (
              <AgentModels key={p} agentId={p} hidden={hiddenModels} onToggle={toggleModel} />
            ),
          )}
        </div>
      )}
    </SettingsCard>
  );
}
