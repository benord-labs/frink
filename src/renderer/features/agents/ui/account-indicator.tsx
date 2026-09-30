import openaiLogo from '@iconify-icons/ri/openai-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/* eslint-disable max-lines, max-lines-per-function */
import { useAtomValue, useSetAtom } from 'jotai';
import { Check, ChevronDown, Plus, RefreshCw, Settings, User } from 'lucide-react';
import { Fragment, memo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  pendingAccountAuthAtom,
} from '../../../lib/atoms';
import { useNewChatAccount } from '../../../lib/hooks/use-new-chat-account';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { pendingChatRetryAtomFamily } from '../atoms';
import { RetryActionButton } from '../main/active-chat/components/RetryActionButton';
import { HeaderBadge } from './header-badge';

const CodexIcon = iconifyComponent(openaiLogo);

const PROVIDER_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'OpenAI',
} as const satisfies Record<'claude-code' | 'codex', string>;

/** Provider glyph for the trigger badge and each dropdown row. Codex has a brand mark; Claude falls back to the generic user icon. */
function ProviderGlyph({
  type,
  className,
}: {
  type?: 'claude-code' | 'codex' | null;
  className?: string;
}) {
  if (type === 'codex') return <CodexIcon className={className} aria-hidden />;
  return <User className={className} aria-hidden />;
}

type AccountType = 'claude-code' | 'codex';
type PickableAccount = { id: string; label: string; type: AccountType; isAuthenticated: boolean };

/** One signed-in login under its provider's heading. */
function AccountRow({
  row,
  isActive,
  onPick,
}: {
  row: PickableAccount;
  isActive: boolean;
  onPick: (accountId: string) => void;
}) {
  return (
    <DropdownMenuItem className="gap-2" onSelect={() => onPick(row.id)}>
      <ProviderGlyph type={row.type} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
        {row.label}
      </span>
      {isActive ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Active" />
      ) : null}
    </DropdownMenuItem>
  );
}

/** Opens Settings → Accounts, where logins are added; no chat surface sets one up itself. */
function useOpenAccountsSettings() {
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  return useCallback(() => {
    setSettingsActiveTab('models');
    setSettingsOpen(true);
  }, [setSettingsActiveTab, setSettingsOpen]);
}

const USAGE_LIMIT_ERROR_CATEGORY = 'RATE_LIMIT_SDK';

/** Beside a usage-limit Retry: retry this chat on another Claude login, or add one. */
export function ContinueAfterUsageLimit({
  chatId,
  subChatId,
  onRetry,
}: {
  chatId: string;
  subChatId: string;
  onRetry: () => void;
}) {
  const pendingRetry = useAtomValue(pendingChatRetryAtomFamily(subChatId));
  const utils = trpc.useUtils();
  const openAccountsSettings = useOpenAccountsSettings();
  const setChatAccount = trpc.chats.setChatAccount.useMutation({
    onSuccess: () => void utils.claudeCode.getResolvedAccount.invalidate({ chatId }),
    onError: (err) => toast.error(err.message),
  });
  const { data: account } = trpc.claudeCode.getResolvedAccount.useQuery({ chatId });
  const { data: accounts = [] } = trpc.claudeCode.listAccounts.useQuery();
  if (pendingRetry?.errorCategory !== USAGE_LIMIT_ERROR_CATEGORY || !account) return null;
  // Only another Claude login resumes this session natively; Codex has one login per device.
  if (account.type === 'codex') return null;
  const others = accounts.filter(
    (a) => a.isAuthenticated && a.type === 'claude-code' && a.id !== account.id,
  );
  if (others.length === 0) {
    return (
      <RetryActionButton
        icon={Plus}
        onClick={openAccountsSettings}
        ariaLabel="Add another AI account"
        label="Add account…"
      />
    );
  }
  return (
    <>
      {others.map((a) => (
        <RetryActionButton
          key={a.id}
          onClick={() => setChatAccount.mutate({ chatId, accountId: a.id }, { onSuccess: onRetry })}
          disabled={setChatAccount.isPending}
          ariaLabel={`Retry with ${a.label}`}
          label={`Retry with ${a.label}`}
          tooltipText={`The conversation continues on ${a.label}'s organisation, and this chat stays on that login.`}
        />
      ))}
    </>
  );
}

/** The new-chat tooltip's scope line: where the shown login comes from. */
function newChatScope(isPicked: boolean, projectId?: string, isProjectOverride?: boolean) {
  if (isPicked) return 'Chosen for this chat';
  if (isProjectOverride) return 'Project-specific account';
  return projectId ? 'Workspace default for this project' : 'Default account';
}

/** Signed-in logins, grouped by provider, for the new-chat picker. */
function groupSignedIn(accounts: PickableAccount[]) {
  const signedIn = accounts
    .filter((a) => a.isAuthenticated)
    .sort((a, b) => a.label.localeCompare(b.label));
  return (['claude-code', 'codex'] as const)
    .map((type) => ({ type, rows: signedIn.filter((a) => a.type === type) }))
    .filter((group) => group.rows.length > 0);
}

type ShownAccount = {
  label: string;
  type?: AccountType | null;
  isAuthenticated: boolean;
  source?: string | null;
  isProjectOverride?: boolean;
};

/** The badge's provider, tooltip scope and hint lines, and aria-label, for a chat or a new chat. */
function badgeCopy(
  account: ShownAccount,
  chatId: string | undefined,
  isPicked: boolean,
  projectId?: string,
) {
  const providerLabel = PROVIDER_LABEL[account.type ?? 'claude-code'];
  const menuLabel = `AI accounts menu, ${account.label}, ${providerLabel}`;
  if (chatId) {
    return {
      providerLabel,
      scope: `This chat always uses ${account.label}`,
      hint: 'Start a new chat to use a different account.',
      ariaLabel: menuLabel,
    };
  }
  return {
    providerLabel,
    scope: newChatScope(isPicked, projectId, account.isProjectOverride),
    hint: 'Your choice applies to this new chat only.',
    ariaLabel: account.isProjectOverride ? `${menuLabel}, project-specific default` : menuLabel,
  };
}

/** The new-chat picker: signed-in logins under their provider headings. */
function NewChatAccountRows({
  accounts,
  activeId,
  onPick,
}: {
  accounts: PickableAccount[];
  activeId: string;
  onPick: (accountId: string) => void;
}) {
  const groups = groupSignedIn(accounts);
  return (
    <>
      {groups.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No signed-in accounts.</div>
      ) : (
        groups.map((group) => (
          <Fragment key={group.type}>
            <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground leading-snug">
              {PROVIDER_LABEL[group.type]}
            </DropdownMenuLabel>
            {group.rows.map((a) => (
              <AccountRow key={a.id} row={a} isActive={a.id === activeId} onPick={onPick} />
            ))}
          </Fragment>
        ))
      )}
      <DropdownMenuSeparator />
    </>
  );
}

/** The badge tooltip: the login, its provider and scope, and why a signed-out login needs action. */
function AccountTooltipBody({
  account,
  providerLabel,
  scope,
  hint,
}: {
  account: ShownAccount;
  providerLabel: string;
  scope: string;
  hint: string;
}) {
  return (
    <div className="text-xs max-w-64">
      <div className="font-medium">{account.label}</div>
      <div className="text-muted-foreground">{providerLabel}</div>
      <div className="text-muted-foreground">{scope}</div>
      {!account.isAuthenticated && (
        <div className="text-warning mt-1">
          {account.source === 'claude-passthrough'
            ? 'Claude Code login expired on this machine. Click for the Reconnect option.'
            : account.source === 'codex-passthrough'
              ? 'OpenAI login expired on this machine. Click for the Reconnect option.'
              : 'Not authenticated on this machine — open Settings to update the API key.'}
        </div>
      )}
      <div className="text-muted-foreground mt-1.5 pt-1.5 border-t border-border/60">
        Click for menu. {hint}
      </div>
    </div>
  );
}

/** Re-runs the sign-in for an expired passthrough login; nothing for any other login. */
function ReconnectItem({ account }: { account: ShownAccount }) {
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const isPassthrough =
    account.source === 'claude-passthrough' || account.source === 'codex-passthrough';
  if (!isPassthrough || account.isAuthenticated) return null;
  const isCodex = account.source === 'codex-passthrough';
  return (
    <DropdownMenuItem
      className="text-xs gap-2 text-foreground"
      onSelect={() =>
        setPendingAccountAuth({
          mode: 'reauth',
          accountLabel: account.label,
          returnToSettings: false,
          provider: isCodex ? 'codex' : undefined,
        })
      }
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Reconnect {isCodex ? 'OpenAI' : 'Claude Code'} login</span>
    </DropdownMenuItem>
  );
}

type AccountIndicatorProps = {
  /** Chat ID — used to resolve the account for an existing chat. */
  chatId?: string;
  /** Project ID — used to resolve the account for a new chat (before a chat exists). */
  projectId?: string;
};

/**
 * Shows which AI account is active. A chat's badge is read-only: it always uses its own login.
 * Before a chat exists, a row picks the login for that new chat only.
 */
export const AccountIndicator = memo(function AccountIndicator({
  chatId,
  projectId,
}: AccountIndicatorProps) {
  const handleOpenAccountsSettings = useOpenAccountsSettings();
  const chatAccount = trpc.claudeCode.getResolvedAccount.useQuery(
    { chatId },
    { staleTime: 30000, enabled: Boolean(chatId) },
  );
  const draft = useNewChatAccount(projectId, undefined, !chatId);
  const account = chatId ? chatAccount.data : draft.account;

  if (!account) return null;

  const copy = badgeCopy(account, chatId, Boolean(draft.pickedAccountId), projectId);

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <HeaderBadge
              variant="menuTrigger"
              aria-label={copy.ariaLabel}
              // Styled like the pane's icon buttons beside it (24px ghost, foreground icon); as a
              // glyph it is the same 24px square.
              className={cn(
                'h-6 gap-1.5 max-w-[min(14rem,100%)] rounded-md bg-transparent px-1.5 py-0 text-left text-foreground',
                '@max-[18.5rem]/pane-header:w-6 @max-[18.5rem]/pane-header:justify-center @max-[18.5rem]/pane-header:px-0',
                !account.isAuthenticated && 'text-warning bg-[hsl(var(--status-warning)/0.1)]',
              )}
            >
              <ProviderGlyph
                type={account.type}
                className="h-3 w-3 shrink-0 self-center @max-[18.5rem]/pane-header:h-4 @max-[18.5rem]/pane-header:w-4"
              />
              {/* Inside a pane header the provider, then the label, shed so the badge ends as a glyph square. */}
              <span className="min-w-0 flex-1 truncate text-left text-[11px] font-medium leading-tight @max-[18.5rem]/pane-header:hidden">
                {account.label}
                <span className="font-normal text-muted-foreground @max-[26rem]/pane-header:hidden">
                  {' '}
                  - {copy.providerLabel}
                </span>
              </span>
              <ChevronDown
                className="h-3 w-3 shrink-0 self-center opacity-60 @max-[18.5rem]/pane-header:hidden"
                aria-hidden
              />
            </HeaderBadge>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <AccountTooltipBody
            account={account}
            providerLabel={copy.providerLabel}
            scope={copy.scope}
            hint={copy.hint}
          />
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-64 max-h-72 overflow-y-auto"
      >
        {chatId ? null : (
          <NewChatAccountRows
            accounts={draft.accounts}
            activeId={account.id}
            onPick={draft.pickAccount}
          />
        )}
        <ReconnectItem account={account} />
        <DropdownMenuItem className="text-xs gap-2" onSelect={handleOpenAccountsSettings}>
          <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Manage accounts…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
