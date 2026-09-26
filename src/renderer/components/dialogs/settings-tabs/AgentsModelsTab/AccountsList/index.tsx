/* eslint-disable max-lines, max-lines-per-function */

import { useSetAtom } from 'jotai';
import { KeyRound, Plus } from 'lucide-react';
import { type ComponentProps, type ReactElement, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { AccountsErrorBanner } from '@/components/ui/accounts-error-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { notifyToolSwitch } from '@/utils/tool-switch-message';
import { LAUNCH_FLAGS } from '../../../../../../shared/launch-flags';
import { agentsSettingsDialogOpenAtom, pendingAccountAuthAtom } from '../../../../../lib/atoms';
import { trpc } from '../../../../../lib/trpc';
import { isWindows } from '../../../../../lib/utils/platform';
import { AccountRow } from '../AccountRow';
import { AddAccountForm } from '../AddAccountForm';
import {
  type AccountAuthSelection,
  buildPendingAddState,
  nextApiKeyName,
  shouldUseInlineCredentialEdit,
} from '../auth-flow-utils';
import { ProviderTile } from '../ProviderTile';

type Props = {
  onAuthenticate: (account: AccountAuthSelection) => void;
  accounts: Array<ComponentProps<typeof AccountRow>['account']>;
  refetchAccounts: () => Promise<unknown>;
  /** This device already has its one Claude Code login, so the Add menu omits that choice. */
  hasClaudePassthrough?: boolean;
  /** This device already has its one Codex login, so the Add menu omits that choice. */
  hasCodexPassthrough?: boolean;
  /** listAccounts failed after fetch; rows below may be stale cache. */
  accountsListFailed?: boolean;
};

export function AccountsList({
  onAuthenticate,
  accounts,
  refetchAccounts,
  hasClaudePassthrough,
  hasCodexPassthrough,
  accountsListFailed = false,
}: Props): ReactElement {
  const [showAddForm, setShowAddForm] = useState(false);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingRenameAccountId, setEditingRenameAccountId] = useState<string | null>(null);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const trpcUtils = trpc.useUtils();

  const addAccountMutation = trpc.claudeCode.addAccount.useMutation({
    onSuccess: () => {
      toast.success('Account added');
      setShowAddForm(false);
      refetchAccounts();
    },
    onError: (err) => toast.error(err.message),
  });

  // Success toast fired per-call in handleSetDefault (switch-aware). The base
  // onSuccess only refetches — react-query runs both, so a toast here too would
  // double-fire.
  const setDefaultMutation = trpc.claudeCode.setDefault.useMutation({
    onSuccess: () => {
      refetchAccounts();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteAccountMutation = trpc.claudeCode.deleteAccount.useMutation({
    onSuccess: () => {
      toast.success('Account deleted');
      setEditingAccountId(null);
      setEditingRenameAccountId(null);
      refetchAccounts();
      void trpcUtils.claudeCode.getResolvedAccount.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const disconnectPassthroughMutation = trpc.claudeCode.disconnectClaudePassthrough.useMutation({
    onSuccess: () => {
      toast.success('Login disconnected');
      setEditingAccountId(null);
      setEditingRenameAccountId(null);
      refetchAccounts();
      // Bust the resolved-account cache too — `AccountIndicator` keys off it
      // and would otherwise show the stale (now-orphan) account label until
      // its 30s React-Query staleTime expired.
      void trpcUtils.claudeCode.getResolvedAccount.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const renameAccountMutation = trpc.claudeCode.renameAccount.useMutation({
    onSuccess: () => {
      toast.success('Account renamed');
      setEditingRenameAccountId(null);
      refetchAccounts();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSetDefault = useCallback(
    (id: string) => {
      const oldType = accounts.find((a) => a.isDefault)?.type;
      const newType = accounts.find((a) => a.id === id)?.type;
      setDefaultMutation.mutate(
        { id },
        { onSuccess: () => notifyToolSwitch(oldType, newType, 'Default account updated') },
      );
    },
    [accounts, setDefaultMutation],
  );
  const handleDelete = useCallback(
    (id: string) => {
      // Passthrough rows (claude + codex) are local-only and unlinked from the
      // cloud — route them through `disconnectClaudePassthrough` so we DON'T
      // tombstone a (possibly shared) cloud account row from another machine and
      // so the source-readers cache is invalidated.
      const account = accounts.find((a) => a.id === id);
      if (account?.source?.endsWith('-passthrough')) {
        disconnectPassthroughMutation.mutate({ accountId: id });
        return;
      }
      deleteAccountMutation.mutate({ id });
    },
    [accounts, deleteAccountMutation, disconnectPassthroughMutation],
  );
  const handleAuthenticate = useCallback(
    (account: AccountAuthSelection) => {
      if (shouldUseInlineCredentialEdit(account)) {
        setEditingRenameAccountId(null);
        setEditingAccountId(account.id);
      } else {
        onAuthenticate({
          id: account.id,
          label: account.label,
          type: account.type,
          source: account.source,
        });
      }
    },
    [onAuthenticate],
  );
  const handleRenameClick = useCallback((id: string) => {
    setEditingAccountId(null);
    setEditingRenameAccountId(id);
  }, []);
  const handleSaveRename = useCallback(
    (id: string, newLabel: string) =>
      renameAccountMutation.mutate({ id, newLabel: newLabel.trim() }),
    [renameAccountMutation],
  );
  const handleCancelRename = useCallback(() => setEditingRenameAccountId(null), []);

  const handleAddWithToken = (label: string, oauthToken: string) => {
    addAccountMutation.mutate({ label, token: oauthToken });
  };

  const handleAddWithApiKey = (label: string, apiKey: string) => {
    addAccountMutation.mutate({ label, token: apiKey, isApiKey: true });
  };

  const startSignIn = (provider?: 'codex') => {
    setPendingAccountAuth(buildPendingAddState(provider));
    setSettingsOpen(false);
  };

  const closeAddForm = () => {
    setShowAddForm(false);
    requestAnimationFrame(() => addTriggerRef.current?.focus());
  };

  return (
    <SettingsCard>
      {accountsListFailed ? (
        <AccountsErrorBanner
          message="Could not refresh accounts. The list below may be out of date until this succeeds."
          onRetry={refetchAccounts}
        />
      ) : null}
      {accounts.length > 0 ? (
        <ul className="divide-y divide-border/50">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              isEditing={editingAccountId === account.id}
              isEditingRename={editingRenameAccountId === account.id}
              onSetDefault={handleSetDefault}
              onDelete={handleDelete}
              onAuthenticate={handleAuthenticate}
              onCancelEdit={() => setEditingAccountId(null)}
              onTokenSaved={() => {
                setEditingAccountId(null);
                refetchAccounts();
              }}
              onRenameClick={handleRenameClick}
              renamePending={
                editingRenameAccountId === account.id && renameAccountMutation.isPending
              }
              onSaveRename={handleSaveRename}
              onCancelRename={handleCancelRename}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 pt-4 text-sm text-muted-foreground">
          No accounts yet. Add one to start chatting.
        </p>
      )}

      {showAddForm ? (
        <AddAccountForm
          defaultName={nextApiKeyName(accounts.map((a) => a.label))}
          onAddWithToken={handleAddWithToken}
          onAddWithApiKey={handleAddWithApiKey}
          onCancel={closeAddForm}
          isPending={addAccountMutation.isPending}
        />
      ) : (
        <AddAccountMenu
          triggerRef={addTriggerRef}
          withBorder={accounts.length > 0}
          canSignInClaude={!isWindows() && !hasClaudePassthrough}
          canSignInCodex={LAUNCH_FLAGS.codexAccounts && !hasCodexPassthrough}
          onSignIn={startSignIn}
          onAddKey={() => setShowAddForm(true)}
        />
      )}
    </SettingsCard>
  );
}

const ADD_ROW_CLASS =
  'flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/** The card's last row. Choices this device can't use are left out; one choice skips the menu. */
function AddAccountMenu({
  triggerRef,
  withBorder,
  canSignInClaude,
  canSignInCodex,
  onSignIn,
  onAddKey,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  withBorder: boolean;
  canSignInClaude: boolean;
  canSignInCodex: boolean;
  onSignIn: (provider?: 'codex') => void;
  onAddKey: () => void;
}): ReactElement {
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={ADD_ROW_CLASS}
      onClick={canSignInClaude || canSignInCodex ? undefined : onAddKey}
    >
      <span className="flex size-9 items-center justify-center rounded-[10px] border border-dashed border-border">
        <Plus className="size-4" aria-hidden />
      </span>
      Add an account
    </button>
  );
  return (
    <div className={withBorder ? 'border-t border-border/50' : undefined}>
      {canSignInClaude || canSignInCodex ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {canSignInClaude ? (
              <DropdownMenuItem onClick={() => onSignIn()}>
                <ProviderTile type="claude-code" size="sm" />
                Sign in with Claude
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onAddKey}>
              <KeyRound className="size-4" aria-hidden />
              Add a Claude API key
            </DropdownMenuItem>
            {canSignInCodex ? (
              <DropdownMenuItem onClick={() => onSignIn('codex')}>
                <ProviderTile type="codex" size="sm" />
                Sign in with OpenAI
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        trigger
      )}
    </div>
  );
}
