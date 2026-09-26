import { Button, Input } from '@benord-labs/frink-primitives';
import { Check, MoreHorizontal } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../../../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../../ui/dropdown-menu';
import {
  type AccountAuthSelection,
  type AccountType,
  shouldUseInlineCredentialEdit,
} from '../auth-flow-utils';
import { PROVIDER_NAME, ProviderTile } from '../ProviderTile';
import { ApiKeyEditForm } from './ApiKeyEditForm';

type Props = {
  account: {
    id: string;
    label: string;
    isDefault: boolean;
    isAuthenticated: boolean;
    connectedAt: string | null;
    expectedEmail?: string | null;
    isApiKey?: boolean;
    type?: AccountType;
    /**
     * Credential storage model. `claude-passthrough` / `codex-passthrough` rows
     * live only on this device — deleting them must NOT tombstone the
     * (cloud-shared) account on other machines. See `AccountsList.handleDelete`.
     */
    source?: 'api-key' | 'claude-passthrough' | 'codex-passthrough';
  };
  isEditing?: boolean;
  isEditingRename?: boolean;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
  onAuthenticate: (account: AccountAuthSelection) => void;
  onCancelEdit?: () => void;
  onTokenSaved?: () => void;
  onRenameClick: (id: string) => void;
  onSaveRename: (id: string, newLabel: string) => void;
  onCancelRename: () => void;
  renamePending?: boolean;
};

/** The one line under the name: which provider, and who is signed in or what is missing. */
function accountDetail(account: Props['account'], type: AccountType, isApiKey: boolean): string {
  let detail: string;
  if (isApiKey) detail = account.isAuthenticated ? 'API key' : 'Needs an API key';
  else if (!account.isAuthenticated) detail = 'Signed out';
  else if (account.expectedEmail && account.expectedEmail !== account.label)
    detail = account.expectedEmail;
  else detail = 'Signed in on this computer';
  return `${PROVIDER_NAME[type]} · ${detail}`;
}

function AccountActionsMenu({
  account,
  isApiKeyAccount,
  actionsRef,
  onSetDefault,
  onAuthenticate,
  onRenameClick,
  onDelete,
}: {
  account: Props['account'];
  isApiKeyAccount: boolean;
  actionsRef: React.RefObject<HTMLButtonElement | null>;
  onSetDefault: (id: string) => void;
  onAuthenticate: (account: AccountAuthSelection) => void;
  onRenameClick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={actionsRef}
          variant="ghost"
          size="sm"
          className="size-8 text-muted-foreground"
          aria-label={`More for ${account.label}`}
          iconOnly
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!account.isDefault && account.isAuthenticated && (
          <DropdownMenuItem onClick={() => onSetDefault(account.id)}>
            Use for new chats
          </DropdownMenuItem>
        )}
        {account.isAuthenticated && (
          <DropdownMenuItem onClick={() => onAuthenticate(account)}>
            {isApiKeyAccount ? 'Replace key' : 'Sign in again'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onRenameClick(account.id)}>Rename</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onDelete(account.id)}
          className="text-destructive focus:text-destructive"
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameForm({
  account,
  renameInputRef,
  renameDraft,
  setRenameDraft,
  renamePending,
  onSaveRename,
  onCancelRename,
  focusActions,
}: {
  account: Props['account'];
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameDraft: string;
  setRenameDraft: (value: string) => void;
  renamePending: boolean;
  onSaveRename: (id: string, newLabel: string) => void;
  onCancelRename: () => void;
  focusActions: () => void;
}) {
  const trimmed = renameDraft.trim();
  const canSave = !!trimmed && trimmed !== account.label && !renamePending;
  const save = () => {
    if (canSave) onSaveRename(account.id, trimmed);
    focusActions();
  };
  const cancel = () => {
    onCancelRename();
    focusActions();
  };
  return (
    <div className="px-4 pb-4 pt-0 space-y-1">
      <div className="flex items-center gap-2">
        <Input
          ref={renameInputRef}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              if (!renamePending) cancel();
            } else if (e.key === 'Enter' && canSave) {
              e.preventDefault();
              save();
            }
          }}
          aria-label="Account name"
          placeholder="Account name"
          size="lg"
          className="min-h-11 flex-1"
          maxLength={100}
          disabled={renamePending}
        />
        <Button size="sm" className="h-11 min-h-11 min-w-[44px]" onClick={save} disabled={!canSave}>
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-11 min-h-11 min-w-[44px]"
          onClick={cancel}
          disabled={renamePending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export const AccountRow = memo(function AccountRow({
  account,
  isEditing,
  isEditingRename,
  onSetDefault,
  onDelete,
  onAuthenticate,
  onCancelEdit,
  onTokenSaved,
  onRenameClick,
  onSaveRename,
  onCancelRename,
  renamePending = false,
}: Props) {
  const accountType: AccountType = account.type === 'codex' ? 'codex' : 'claude-code';
  const isApiKeyAccount = shouldUseInlineCredentialEdit({
    isApiKey: account.isApiKey,
    type: accountType,
  });
  const actionsRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameDraft, setRenameDraft] = useState(account.label);

  useEffect(() => {
    if (isEditingRename) setRenameDraft(account.label);
  }, [isEditingRename, account.label]);

  useEffect(() => {
    if (isEditingRename && !renamePending) {
      renameInputRef.current?.focus();
    }
  }, [isEditingRename, renamePending]);

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-3">
        <ProviderTile type={accountType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{account.label}</p>
          <p
            className={cn(
              'truncate text-sm',
              account.isAuthenticated ? 'text-muted-foreground' : 'text-warning',
            )}
          >
            {accountDetail(account, accountType, isApiKeyAccount)}
          </p>
        </div>

        {!account.isAuthenticated && !isEditing ? (
          <Button size="sm" variant="secondary" onClick={() => onAuthenticate(account)}>
            {isApiKeyAccount ? 'Add key' : 'Sign in again'}
          </Button>
        ) : account.isDefault ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Check className="size-3.5" aria-hidden />
            Used for new chats
          </span>
        ) : null}

        <AccountActionsMenu
          account={account}
          isApiKeyAccount={isApiKeyAccount}
          actionsRef={actionsRef}
          onSetDefault={onSetDefault}
          onAuthenticate={onAuthenticate}
          onRenameClick={onRenameClick}
          onDelete={onDelete}
        />
      </div>

      {isEditing && (
        <ApiKeyEditForm
          accountId={account.id}
          onSave={() => {
            onTokenSaved?.();
            actionsRef.current?.focus();
          }}
          onCancel={() => {
            onCancelEdit?.();
            actionsRef.current?.focus();
          }}
        />
      )}

      {isEditingRename && (
        <RenameForm
          account={account}
          renameInputRef={renameInputRef}
          renameDraft={renameDraft}
          setRenameDraft={setRenameDraft}
          renamePending={renamePending}
          onSaveRename={onSaveRename}
          onCancelRename={onCancelRename}
          focusActions={() => actionsRef.current?.focus()}
        />
      )}
    </li>
  );
});
