import { useSetAtom } from 'jotai';
import type { ReactElement } from 'react';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { useIsNarrowScreen } from '../../../../hooks/use-is-narrow-screen';
import { agentsSettingsDialogOpenAtom, pendingAccountAuthAtom } from '../../../../lib/atoms';
import { trpc } from '../../../../lib/trpc';
import { SettingsTabHeader } from '../SettingsTabHeader';
import { SETTINGS_TAB_PAGE_CLASS } from '../settings-tab-surface';
import { AccountsList } from './AccountsList';
import { type AccountAuthSelection, buildPendingReauthState } from './auth-flow-utils';
import { ModelsSection } from './ModelsSection';

export function AgentsModelsTab(): ReactElement {
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const isNarrowScreen = useIsNarrowScreen();
  const {
    data: accounts,
    refetch: refetchAccounts,
    isSuccess: accountsQuerySuccess,
    isFetched: accountsQueryFetched,
    isError: accountsQueryError,
  } = trpc.claudeCode.listAccounts.useQuery();
  // `source` is already narrowed to the runtime union at the tRPC boundary
  // (see `listAccounts` in claude-code.ts), so downstream components can branch
  // on it directly.
  const accountRows = accounts ?? [];
  // One Claude Code login per device — used to disable the "Use Claude Code login"
  // CTA in the AddAccountForm so the user doesn't accidentally rename their
  // existing passthrough by adding a "new" account with a different label.
  const hasClaudePassthrough = accountRows.some(
    (account) => account.source === 'claude-passthrough',
  );
  // One Codex login per device — mirrors hasClaudePassthrough for the Codex connect CTA.
  const hasCodexPassthrough = accountRows.some((account) => account.source === 'codex-passthrough');

  const authGateReady = accountsQuerySuccess;
  const accountsListFailed = accountsQueryFetched && accountsQueryError;
  const showClaudeModels = accountRows.some((a) => a.type === 'claude-code' && a.isAuthenticated);
  const showCodexModels = accountRows.some((a) => a.type === 'codex' && a.isAuthenticated);

  const handleAuthenticate = (account: AccountAuthSelection) => {
    setPendingAccountAuth(buildPendingReauthState(account));
    setSettingsOpen(false);
  };

  return (
    <div className={SETTINGS_TAB_PAGE_CLASS}>
      <SettingsTabHeader
        title="AI providers"
        description="Sign in to the AI you want Frink to use, and pick which models show up in chats."
        narrow={isNarrowScreen}
      />

      <SettingsSection
        title="Accounts"
        description="New chats use the account marked below. You can change it any time."
      >
        <AccountsList
          onAuthenticate={handleAuthenticate}
          accounts={accountRows}
          refetchAccounts={refetchAccounts}
          hasClaudePassthrough={hasClaudePassthrough}
          hasCodexPassthrough={hasCodexPassthrough}
          accountsListFailed={accountsListFailed}
        />
      </SettingsSection>

      <SettingsSection
        title="Models"
        description="Turn off the ones you don't use to keep the model list short."
      >
        <ModelsSection
          authGateReady={authGateReady}
          showClaudeModels={showClaudeModels}
          showCodexModels={showCodexModels}
          accountsListFailed={accountsListFailed}
          onRetryAccounts={refetchAccounts}
        />
      </SettingsSection>
    </div>
  );
}
