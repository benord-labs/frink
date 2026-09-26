import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { KeyRound, RefreshCw, Sparkles, Terminal } from 'lucide-react';
import { type ReactElement, useId } from 'react';
import { cn } from '@/lib/utils';
import { isWindows } from '@/lib/utils/platform';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  pendingAccountAuthAtom,
} from '../../../lib/atoms';

type Props = {
  /** Compact variant: holds the composer's slot at the bottom of an open chat. */
  compact?: boolean;
  /**
   * Existing-but-unauthenticated row info, when present. Surfaces a re-auth UX
   * instead of the brand-new "no accounts" copy.
   */
  existingAccount?: {
    label: string;
    type: 'claude-code' | 'codex';
  } | null;
};

/** Oxford-comma conjunction list ("A, B, and C") for the supported-providers line. */
const providerListFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * Providers Frink can connect, gated by launch flags. Claude is always offered; Codex surfaces
 * only when its flag is on, so the copy never advertises a provider the user can't select.
 */
const SUPPORTED_PROVIDERS = [
  'Claude (Pro/Max subscription or API key)',
  LAUNCH_FLAGS.codexAccounts && 'OpenAI (Codex sign-in)',
].filter((label): label is string => typeof label === 'string');

/**
 * Inline empty state shown when chat sends are gated by missing/invalid credentials.
 *
 * Two display modes:
 * 1. `existingAccount` is null → first-time UX: Connect Claude OR add an
 *    Anthropic API key via Settings.
 * 2. `existingAccount` is set → that row exists but its token is missing/expired.
 *    Surface a "Reconnect <label>" CTA matched to the row's provider.
 *
 * Windows note: passthrough is mac/linux-only. On win32 we hide the Connect CTA
 * and route the user to API keys with a one-line explanation.
 */
export function NoAccountsEmptyState({ compact, existingAccount = null }: Props): ReactElement {
  const headingId = useId();
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  // Use the renderer-side platform helper (window.desktopApi.platform). The
  // `process` global isn't exposed under contextIsolation, so the previous
  // `process.platform` check silently always reported non-Windows.
  const isWindowsOs = isWindows();

  const handleConnectClaude = () => {
    // Triggers ConnectClaudeAccountPage via the App.tsx pendingAccountAuth gate.
    setPendingAccountAuth({
      mode: 'add',
      accountLabel: '',
      returnToSettings: false,
    });
  };

  const handleConnectCodex = () => {
    // provider:'codex' routes to ConnectCodexAccountPage via the App.tsx discriminator.
    setPendingAccountAuth({
      mode: 'add',
      accountLabel: '',
      returnToSettings: false,
      provider: 'codex',
    });
  };

  const handleReconnectExisting = (label: string, type: 'claude-code' | 'codex') => {
    setPendingAccountAuth({
      mode: 'reauth',
      accountLabel: label,
      returnToSettings: false,
      provider: type === 'codex' ? 'codex' : undefined,
    });
  };

  const handleOpenAccountsSettings = () => {
    setSettingsActiveTab('models');
    setSettingsOpen(true);
  };

  /** Stands in for the composer, so it wears the composer's glass. Compact spans its full width:
   *  the transcript scrolls under it, and a narrower card leaves sharp lines beside it. */
  const cardClassName = cn(
    'mx-auto w-full rounded-2xl border border-border glass-float text-center shadow-xs',
    'ring-1 ring-inset ring-foreground/4',
    compact ? 'composer-slot-surface space-y-3 p-5' : 'max-w-md space-y-5 px-8 py-8',
  );
  const actionsClassName = cn('flex flex-col gap-2', compact && 'mx-auto max-w-sm');

  const headingClassName = cn(
    'font-semibold tracking-tight text-balance',
    compact ? 'text-base' : 'text-lg',
  );

  // Re-auth UX for an existing-but-unauthenticated account.
  if (existingAccount) {
    const isCodex = existingAccount.type === 'codex';
    return (
      <section
        aria-labelledby={headingId}
        className={cardClassName}
        data-testid="no-accounts-empty-state"
      >
        {/*
          a11y: this card is the page's primary heading when the chat editor
          is replaced (see `new-chat-form.tsx`); promote to h1 so the document
          isn't left with an h2 + no h1 (WCAG 1.3.1 / 2.4.6). Live-region
          announcement of the state change is handled by the sibling sr-only
          paragraph below — having the whole interactive panel be a live
          region was causing screen readers to re-announce buttons on every
          re-render.
        */}
        <div className={compact ? 'space-y-2' : 'space-y-2.5'}>
          <h1 id={headingId} className={headingClassName}>
            Reconnect to keep chatting
          </h1>
          <p
            className={cn(
              'text-sm text-muted-foreground text-pretty',
              !compact && 'mx-auto max-w-sm leading-relaxed',
            )}
          >
            <span className="font-medium text-foreground">{existingAccount.label}</span> isn't
            authenticated on this machine.
          </p>
        </div>
        <p className="sr-only" aria-live="polite">
          Account {existingAccount.label} needs to be reconnected on this machine before chatting.
        </p>

        <div className={actionsClassName}>
          {!isWindowsOs && (
            <Button
              size="lg"
              onClick={() => handleReconnectExisting(existingAccount.label, existingAccount.type)}
              className="h-11 gap-2 rounded-lg"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {isCodex ? 'Reconnect OpenAI' : 'Reconnect Claude'}
            </Button>
          )}
          <Button
            variant={isWindowsOs ? 'primary' : 'secondary'}
            size="lg"
            onClick={handleOpenAccountsSettings}
            className="h-11 gap-2 rounded-lg"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Open accounts in Settings
          </Button>
        </div>
      </section>
    );
  }

  // No accounts at all — first-time UX. The "Add API key" CTA routes to
  // Settings → AI providers where the add forms live.
  return (
    <section
      aria-labelledby={headingId}
      className={cardClassName}
      data-testid="no-accounts-empty-state"
    >
      {/* See the existing-account branch above for why this is h1 + the sr-only live region pattern. */}
      <div className={compact ? 'space-y-2' : 'space-y-2.5'}>
        <h1 id={headingId} className={headingClassName}>
          Connect an AI account to chat
        </h1>
        <p
          className={cn(
            'text-sm text-muted-foreground text-pretty',
            !compact && 'mx-auto max-w-sm leading-relaxed',
          )}
        >
          Frink supports {providerListFormatter.format(SUPPORTED_PROVIDERS)}.
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        Connect an AI account before chatting.
      </p>

      <div className={actionsClassName}>
        {!isWindowsOs && (
          <Button size="lg" onClick={handleConnectClaude} className="h-11 gap-2 rounded-lg">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Connect Claude (subscription)
          </Button>
        )}
        {LAUNCH_FLAGS.codexAccounts && !isWindowsOs && (
          <Button
            variant="secondary"
            size="lg"
            onClick={handleConnectCodex}
            className="h-11 gap-2 rounded-lg"
          >
            <Terminal className="h-4 w-4" aria-hidden="true" />
            Connect OpenAI (Codex sign-in)
          </Button>
        )}
        <Button
          variant={isWindowsOs ? 'primary' : 'secondary'}
          size="lg"
          onClick={handleOpenAccountsSettings}
          className="h-11 gap-2 rounded-lg"
        >
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          Add API key
        </Button>
      </div>

      {isWindowsOs && (
        <p className="text-xs text-muted-foreground">
          Claude{LAUNCH_FLAGS.codexAccounts ? ' and OpenAI' : ''} passthrough is only available on
          Mac/Linux today. Use an API key on Windows.
        </p>
      )}
      {!isWindowsOs && !compact && (
        <p className="border-t border-border/60 pt-4 text-xs text-muted-foreground text-pretty">
          Connect uses your existing <code className="font-mono text-[11px]">claude</code>
          {LAUNCH_FLAGS.codexAccounts ? (
            <>
              {' or '}
              <code className="font-mono text-[11px]">codex</code>
            </>
          ) : null}{' '}
          CLI login — no token is stored in Frink.
        </p>
      )}
    </section>
  );
}
