import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { notifyToolSwitch } from '@/utils/tool-switch-message';
import { trpc } from '../../../../lib/trpc';
import { Label } from '../../../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';

/** Radix Select value for "use default"; never a real credential id. */
const USE_DEFAULT_VALUE = '__default__';
const ACCOUNT_SELECT_ID = 'project-ai-account';

type ProjectAiAccountSelectorProps = {
  projectId: string;
};

export function ProjectAiAccountSelector({ projectId }: ProjectAiAccountSelectorProps) {
  const utils = trpc.useUtils();
  const { data: accounts } = trpc.claudeCode.listAccounts.useQuery();
  const { data: projectAccountId, refetch: refetchProjectAccount } =
    trpc.claudeCode.getProjectAccount.useQuery({ projectId });

  // The success toast is fired switch-aware in handleSelectAccount; the base
  // onSuccess only refetches/invalidates (react-query runs both, so a toast here
  // too would double-fire).
  const setProjectAccountMutation = trpc.claudeCode.setProjectAccount.useMutation({
    onSuccess: () => {
      refetchProjectAccount();
      utils.claudeCode.getResolvedAccount.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const defaultAccount = accounts?.find((a) => a.isDefault);
  const selectedAccount = projectAccountId
    ? accounts?.find((a) => a.id === projectAccountId)
    : undefined;

  /** Selecting an account (or "Default") sets the per-project tool; tell the
   *  user what carried + what shifts when that changes the coding tool. */
  const handleSelectAccount = (value: string) => {
    const accountId = value === USE_DEFAULT_VALUE ? null : value;
    const oldType = (selectedAccount ?? defaultAccount)?.type;
    const newType = (accountId ? accounts?.find((a) => a.id === accountId) : defaultAccount)?.type;
    setProjectAccountMutation.mutate(
      { projectId, accountId },
      { onSuccess: () => notifyToolSwitch(oldType, newType, 'Account set') },
    );
  };

  return (
    <SettingsSection title="AI">
      <SettingsCard>
        {accounts && accounts.length > 0 ? (
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={ACCOUNT_SELECT_ID} className="text-sm font-medium">
                Account
              </Label>
              <span className="text-xs text-muted-foreground">
                Chats and flows in this project use this account.
              </span>
            </div>
            <Select
              value={projectAccountId ?? USE_DEFAULT_VALUE}
              onValueChange={handleSelectAccount}
              disabled={setProjectAccountMutation.isPending}
            >
              <SelectTrigger id={ACCOUNT_SELECT_ID} className="w-auto min-w-56 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={USE_DEFAULT_VALUE}>
                  {defaultAccount ? `Default (${defaultAccount.label})` : 'Default'}
                </SelectItem>
                {accounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    <span className="flex items-center gap-2">
                      {acc.label}
                      <span className="text-xs text-muted-foreground">
                        {acc.type === 'codex' ? 'OpenAI' : 'Claude Code'}
                        {!acc.isAuthenticated && ' · not signed in'}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            No AI accounts yet. Add one under AI providers.
          </p>
        )}
      </SettingsCard>

      {selectedAccount && !selectedAccount.isAuthenticated && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" />
          <p className="text-xs text-foreground">
            <span className="font-medium">{selectedAccount.label}</span> isn't signed in on this
            computer, so chats here won't start. Sign in under AI providers, or pick another
            account.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}
