import openaiLogo from '@iconify-icons/ri/openai-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/* eslint-disable max-lines, max-lines-per-function */
import { useSetAtom } from 'jotai';
import { Check, ChevronDown, RefreshCw, User } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
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
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { notifyToolSwitch } from '../../../utils/tool-switch-message';
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

type AccountIndicatorProps = {
  /** Chat ID — used to resolve the account for an existing chat. */
  chatId?: string;
  /** Project ID — used to resolve the account for a new chat (before a chat exists). */
  projectId?: string;
};

/**
 * Shows which AI account is active. Row picks set the project’s AI
 * account when this chat is tied to a project; otherwise they set the workspace default.
 * Opens Settings → AI providers from the footer action.
 */
export const AccountIndicator = memo(function AccountIndicator({
  chatId,
  projectId,
}: AccountIndicatorProps) {
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const utils = trpc.useUtils();

  const handleOpenAccountsSettings = useCallback(() => {
    setSettingsActiveTab('models');
    setSettingsOpen(true);
  }, [setSettingsActiveTab, setSettingsOpen]);

  const handleReauthPassthrough = useCallback(
    (label: string, source: string | null | undefined) => {
      setPendingAccountAuth({
        mode: 'reauth',
        accountLabel: label,
        returnToSettings: false,
        provider: source === 'codex-passthrough' ? 'codex' : undefined,
      });
    },
    [setPendingAccountAuth],
  );

  const queryInput = {
    ...(chatId ? { chatId } : {}),
    ...(projectId ? { projectId } : {}),
  };
  const { data: account } = trpc.claudeCode.getResolvedAccount.useQuery(queryInput, {
    staleTime: 30000,
  });

  const { data: accounts = [] } = trpc.claudeCode.listAccounts.useQuery(undefined, {
    staleTime: 30000,
  });

  // The success toast is fired per-call in handlePickAccount (switch-aware); the
  // base onSuccess only invalidates. react-query runs BOTH, so keeping a toast
  // here too would double-fire.
  const setDefaultMutation = trpc.claudeCode.setDefault.useMutation({
    onSuccess: () => {
      void utils.claudeCode.listAccounts.invalidate();
      void utils.claudeCode.getResolvedAccount.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const setProjectAccountMutation = trpc.claudeCode.setProjectAccount.useMutation({
    onSuccess: (_data, variables) => {
      void utils.claudeCode.getResolvedAccount.invalidate();
      void utils.claudeCode.getProjectAccount.invalidate({ projectId: variables.projectId });
    },
    onError: (err) => toast.error(err.message),
  });

  const isAccountMutationPending =
    setDefaultMutation.isPending || setProjectAccountMutation.isPending;

  const handlePickAccount = useCallback(
    (
      row: { id: string; label: string; type: 'claude-code' | 'codex' },
      scopedProjectId: string | null,
    ) => {
      const oldType = account?.type ?? 'claude-code';
      if (scopedProjectId) {
        setProjectAccountMutation.mutate(
          { projectId: scopedProjectId, accountId: row.id },
          { onSuccess: () => notifyToolSwitch(oldType, row.type, 'Account set') },
        );
      } else {
        setDefaultMutation.mutate(
          { id: row.id },
          { onSuccess: () => notifyToolSwitch(oldType, row.type, 'Default account updated') },
        );
      }
    },
    [account?.type, setDefaultMutation, setProjectAccountMutation],
  );

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.label.localeCompare(b.label)),
    [accounts],
  );

  if (!account) return null;

  const providerLabel = PROVIDER_LABEL[account.type ?? 'claude-code'];
  const scopedProjectId = account.projectId ?? null;
  const ariaLabel = account.isProjectOverride
    ? `AI accounts menu, ${account.label}, ${providerLabel}, project-specific default`
    : `AI accounts menu, ${account.label}, ${providerLabel}`;

  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <HeaderBadge
              variant="menuTrigger"
              aria-label={ariaLabel}
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
                  - {providerLabel}
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
          <div className="text-xs max-w-64">
            <div className="font-medium">{account.label}</div>
            <div className="text-muted-foreground">{providerLabel}</div>
            {scopedProjectId ? (
              account.isProjectOverride ? (
                <div className="text-muted-foreground">Project-specific account</div>
              ) : (
                <div className="text-muted-foreground">Workspace default for this project</div>
              )
            ) : (
              <div className="text-muted-foreground">Default account</div>
            )}
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
              {scopedProjectId ? (
                <>Click for menu. Choosing an account sets it for this project.</>
              ) : (
                <>
                  Click for menu. Choosing an account sets your{' '}
                  <span className="text-foreground/90">workspace default</span>.
                </>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-64 max-h-72 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground leading-snug">
          {scopedProjectId
            ? 'Choosing an account sets the AI account for this project.'
            : 'Choosing an account sets your workspace default.'}
        </DropdownMenuLabel>
        {sortedAccounts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No accounts configured.</div>
        ) : (
          sortedAccounts.map((a) => {
            const rowProvider = PROVIDER_LABEL[a.type];
            const isActive = a.id === account.id;
            const needsAuth = !a.isAuthenticated;
            return (
              <DropdownMenuItem
                key={a.id}
                disabled={isAccountMutationPending || needsAuth}
                title={needsAuth ? 'Sign in under Settings → AI providers' : undefined}
                className={cn('gap-2', needsAuth && 'opacity-60 data-disabled:opacity-60')}
                aria-label={
                  needsAuth
                    ? `${a.label}, ${rowProvider}, not signed in on this machine`
                    : undefined
                }
                onSelect={() => {
                  if (!isActive) handlePickAccount(a, scopedProjectId);
                }}
              >
                <ProviderGlyph
                  type={a.type}
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    needsAuth ? 'text-muted-foreground/70' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span
                    className={cn(
                      'font-medium',
                      needsAuth ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {a.label}
                  </span>
                  <span className="text-muted-foreground"> · {rowProvider}</span>
                </span>
                {isActive ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Active" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        {(account.source === 'claude-passthrough' || account.source === 'codex-passthrough') &&
          !account.isAuthenticated && (
            <DropdownMenuItem
              className="text-xs gap-2 text-foreground"
              onSelect={() => handleReauthPassthrough(account.label, account.source)}
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Reconnect {account.source === 'codex-passthrough' ? 'OpenAI' : 'Claude Code'} login
              </span>
            </DropdownMenuItem>
          )}
        <DropdownMenuItem className="text-xs" onSelect={handleOpenAccountsSettings}>
          Manage in Settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
