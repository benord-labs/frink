import { useAtom } from 'jotai';
import { ChevronDown } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { cn } from '@/lib/utils';
import {
  CLAUDE_MODEL_FAMILIES,
  CODEX_MODEL_FAMILIES,
  splitNewestFamilies,
} from '../../../../../../shared/lib/models';
import { hiddenModelsAtom } from '../../../../../lib/atoms';
import { AccountsErrorBanner } from '../../../../ui/accounts-error-banner';
import { Switch } from '../../../../ui/switch';
import type { AccountType } from '../auth-flow-utils';
import { PROVIDER_NAME, ProviderTile } from '../ProviderTile';

type Family = { id: string; name: string };

const CATALOG = {
  'claude-code': CLAUDE_MODEL_FAMILIES,
  codex: CODEX_MODEL_FAMILIES,
} satisfies Record<AccountType, readonly Family[]>;

type Props = {
  /** When false, show full catalog (avoids empty flash while listAccounts is loading). */
  authGateReady: boolean;
  showClaudeModels: boolean;
  showCodexModels: boolean;
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

function ProviderModels({
  provider,
  hidden,
  onToggle,
}: {
  provider: AccountType;
  hidden: string[];
  onToggle: (provider: AccountType, family: Family) => void;
}): ReactElement {
  const { newest, older } = splitNewestFamilies(CATALOG[provider]);
  // Start open when the only models left on are older ones, so they can be seen.
  const [showOlder, setShowOlder] = useState(() => newest.every((f) => hidden.includes(f.id)));
  const row = (family: Family) => (
    <ModelRow
      key={family.id}
      family={family}
      on={!hidden.includes(family.id)}
      onToggle={() => onToggle(provider, family)}
    />
  );
  return (
    <div className="pb-2">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1">
        <ProviderTile type={provider} size="sm" />
        <span className="text-sm font-medium text-foreground">{PROVIDER_NAME[provider]}</span>
      </div>
      <ul>
        {newest.map(row)}
        {showOlder ? older.map(row) : null}
      </ul>
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

export function ModelsSection({
  authGateReady,
  showClaudeModels,
  showCodexModels,
  accountsListFailed = false,
  onRetryAccounts,
}: Props) {
  const [hiddenModels, setHiddenModels] = useAtom(hiddenModelsAtom);

  // Until accounts load, show every provider rather than flashing an empty card.
  const providers = (['claude-code', 'codex'] as const).filter(
    (p) => !authGateReady || (p === 'codex' ? showCodexModels : showClaudeModels),
  );

  const toggleModel = (provider: AccountType, family: Family) => {
    if (hiddenModels.includes(family.id)) {
      setHiddenModels(hiddenModels.filter((id) => id !== family.id));
      return;
    }
    const othersOn = CATALOG[provider].some(
      (f) => f.id !== family.id && !hiddenModels.includes(f.id),
    );
    if (!othersOn) {
      toast.info(`Keep at least one ${PROVIDER_NAME[provider]} model on.`);
      return;
    }
    setHiddenModels([...hiddenModels, family.id]);
  };

  return (
    <SettingsCard>
      {accountsListFailed ? (
        <AccountsErrorBanner
          message="Could not load accounts. All models are shown until this succeeds, including providers you have not connected."
          onRetry={onRetryAccounts}
        />
      ) : null}
      {providers.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Add an account above to choose its models.
        </p>
      ) : (
        <div className="divide-y divide-border/50">
          {providers.map((p) => (
            <ProviderModels key={p} provider={p} hidden={hiddenModels} onToggle={toggleModel} />
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
