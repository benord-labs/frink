import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { type ReactElement, type ReactNode, useId } from 'react';
import {
  PROVIDER_NAME,
  ProviderMark,
  ProviderTile,
} from '@/components/dialogs/settings-tabs/AgentsModelsTab/ProviderTile';
import { cn } from '@/lib/utils';
import { isWindows } from '@/lib/utils/platform';
import { LAUNCH_FLAGS } from '../../../../shared/launch-flags';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  type PendingAccountAuthState,
  pendingAccountAuthAtom,
} from '../../../lib/atoms';

type Provider = 'claude-code' | 'codex';

type SignedOutAccount = {
  label: string;
  type: Provider;
};

type Props = {
  /** Compact variant: holds the composer's slot at the bottom of an open chat. */
  compact?: boolean;
  /** The resolved account when it exists but is signed out on this machine. */
  existingAccount?: SignedOutAccount | null;
};

/** What every layout of this state needs; `account` is the signed-out account, if any. */
type StateProps = {
  headingId: string;
  account: SignedOutAccount | null;
  canSignIn: boolean;
  others: Provider[];
  onConnect: (provider: Provider) => void;
  onReauth: () => void;
  onOpenSettings: () => void;
};

/** The composer's glass: this state stands in for the composer, whole card or provider list. */
const SURFACE_CLASS =
  'rounded-2xl border border-border glass-float shadow-xs ring-1 ring-inset ring-foreground/4';

const LINK_CLASS =
  'cursor-pointer rounded-sm text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const FOOTNOTE_CLASS = 'mt-5 text-center text-[13px] text-muted-foreground text-pretty';

const PROVIDER_COPY = {
  'claude-code': {
    plan: 'Pro or Max plan, through Claude Code',
    switchTo: 'Or switch to your Claude plan',
  },
  codex: { plan: 'ChatGPT plan, through Codex', switchTo: 'Or switch to your ChatGPT plan' },
} satisfies Record<Provider, { plan: string; switchTo: string }>;

const PROVIDER_NAMES = LAUNCH_FLAGS.codexAccounts ? 'Claude or OpenAI' : 'Claude';
const WINDOWS_NOTE = `Signing in with ${PROVIDER_NAMES} needs macOS or Linux.`;

/** Providers this device can sign in to. Passthrough sign-in is macOS/Linux only. */
function signInProviders(): Provider[] {
  // The renderer-side platform helper: `process` isn't exposed under contextIsolation.
  if (isWindows()) return [];
  return LAUNCH_FLAGS.codexAccounts ? ['claude-code', 'codex'] : ['claude-code'];
}

/** Opens the provider's connect page through the App.tsx pendingAccountAuth gate. */
function pendingAuth(provider: Provider, reauthLabel?: string): PendingAccountAuthState {
  return {
    mode: reauthLabel ? 'reauth' : 'add',
    accountLabel: reauthLabel ?? '',
    returnToSettings: false,
    provider,
  };
}

function SettingsLink({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" onClick={onClick} className={LINK_CLASS}>
      {label}
    </button>
  );
}

function ReauthButton({ onClick }: { onClick: () => void }): ReactElement {
  return (
    <Button size="sm" onClick={onClick}>
      Sign in again
    </Button>
  );
}

/** No sign-in on this device, so Settings (API keys) is the only way forward. */
function SettingsButton({
  account,
  onClick,
}: Pick<StateProps, 'account'> & { onClick: () => void }): ReactElement {
  return (
    <Button size="sm" onClick={onClick}>
      {account ? 'Open Settings' : 'Add an API key'}
    </Button>
  );
}

function ConnectButton({
  provider,
  onConnect,
  children,
}: {
  provider: Provider;
  onConnect: StateProps['onConnect'];
  children: ReactNode;
}): ReactElement {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Connect ${PROVIDER_NAME[provider]}`}
      onClick={() => onConnect(provider)}
    >
      {children}
    </Button>
  );
}

function ProviderRow({
  type,
  name,
  detail,
  signedOut = false,
  action,
}: {
  type: Provider;
  name: string;
  detail: string;
  signedOut?: boolean;
  action: ReactNode;
}): ReactElement {
  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <ProviderTile type={type} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p
          className={cn(
            'truncate text-[13px]',
            signedOut ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {detail}
        </p>
      </div>
      {action}
    </li>
  );
}

function compactDetail({ account, canSignIn, others, onOpenSettings }: StateProps): ReactNode {
  if (account) {
    return others.length
      ? `Sign back in, or switch to ${PROVIDER_NAME[others[0]]}.`
      : 'Sign back in to keep chatting.';
  }
  if (!canSignIn) return WINDOWS_NOTE;
  return (
    <>
      Use your own account, or <SettingsLink label="add an API key" onClick={onOpenSettings} />.
    </>
  );
}

/** A single card in the composer slot of an open chat. */
function CompactCard(props: StateProps): ReactElement {
  const { headingId, account, canSignIn, others, onConnect, onReauth, onOpenSettings } = props;
  const heading = account ? `${account.label} was signed out` : 'Connect an AI to keep chatting';
  return (
    <section
      aria-labelledby={headingId}
      data-testid="no-accounts-empty-state"
      // Spans the composer column: the transcript scrolls under it, and a narrower card leaves
      // sharp lines beside it.
      className={cn('composer-slot-surface mx-auto w-full', SURFACE_CLASS)}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-medium text-foreground">
            {heading}
          </h2>
          <p className="text-[13px] text-muted-foreground text-pretty">{compactDetail(props)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSignIn ? (
            <>
              {account && <ReauthButton onClick={onReauth} />}
              {others.map((p) => (
                <ConnectButton key={p} provider={p} onConnect={onConnect}>
                  <ProviderMark type={p} />
                  {PROVIDER_NAME[p]}
                </ConnectButton>
              ))}
            </>
          ) : (
            <SettingsButton account={account} onClick={onOpenSettings} />
          )}
        </div>
      </div>
      {/* Announces the state change without making the whole panel a live region. */}
      <p className="sr-only" aria-live="polite">
        {heading}
      </p>
    </section>
  );
}

function ProviderList({ account, others, onConnect, onReauth }: StateProps): ReactElement {
  return (
    <ul className={cn('divide-y divide-border/60 overflow-hidden', SURFACE_CLASS)}>
      {account && (
        <ProviderRow
          type={account.type}
          name={account.label}
          detail={`${PROVIDER_NAME[account.type]} · Signed out`}
          signedOut
          action={<ReauthButton onClick={onReauth} />}
        />
      )}
      {others.map((p) => (
        <ProviderRow
          key={p}
          type={p}
          name={PROVIDER_NAME[p]}
          detail={account ? PROVIDER_COPY[p].switchTo : PROVIDER_COPY[p].plan}
          action={
            <ConnectButton provider={p} onConnect={onConnect}>
              Connect
            </ConnectButton>
          }
        />
      ))}
    </ul>
  );
}

function Footnote({ account, canSignIn, onOpenSettings }: StateProps): ReactElement | null {
  // On Windows a signed-out account already gets the Open Settings button.
  if (!canSignIn) return account ? null : <p className={FOOTNOTE_CLASS}>{WINDOWS_NOTE}</p>;
  return (
    <p className={FOOTNOTE_CLASS}>
      {account ? (
        <>
          Other accounts and API keys are in{' '}
          <SettingsLink label="Settings" onClick={onOpenSettings} />
        </>
      ) : (
        <>
          Have an Anthropic API key?{' '}
          <SettingsLink label="Add it in Settings" onClick={onOpenSettings} />
        </>
      )}
    </p>
  );
}

/** Replaces the new-chat hero: the heading takes the title's place, the list the composer's. */
function FullLayout(props: StateProps): ReactElement {
  const { headingId, account, canSignIn, onOpenSettings } = props;
  const heading = account ? 'Sign back in to keep chatting' : 'Connect an AI to get started';
  return (
    <section aria-labelledby={headingId} data-testid="no-accounts-empty-state" className="w-full">
      <h1
        id={headingId}
        className="text-center text-2xl @min-[19.25rem]/hero:text-4xl text-balance font-medium tracking-tight"
      >
        {heading}
      </h1>
      <p className="mt-3 text-center text-[15px] text-muted-foreground text-pretty">
        {account
          ? `${account.label} was signed out on this computer.`
          : `Frink works through your own ${PROVIDER_NAMES} account.`}
      </p>
      <div className="mx-auto mt-8 max-w-lg">
        {canSignIn ? (
          <ProviderList {...props} />
        ) : (
          <div className="flex justify-center">
            <SettingsButton account={account} onClick={onOpenSettings} />
          </div>
        )}
        <Footnote {...props} />
      </div>
      <p className="sr-only" aria-live="polite">
        {heading}
      </p>
    </section>
  );
}

/** Stands in for the composer while no account can send: each provider's sign-in, or signing
 *  `existingAccount` back in with the other provider offered as a switch. */
export function NoAccountsEmptyState({ compact, existingAccount = null }: Props): ReactElement {
  const headingId = useId();
  const setPendingAccountAuth = useSetAtom(pendingAccountAuthAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);
  const providers = signInProviders();
  const props: StateProps = {
    headingId,
    account: existingAccount,
    canSignIn: providers.length > 0,
    // The signed-out account gets its own row; every other provider is offered as a switch.
    others: providers.filter((p) => p !== existingAccount?.type),
    onConnect: (provider) => setPendingAccountAuth(pendingAuth(provider)),
    onReauth: () =>
      existingAccount &&
      setPendingAccountAuth(pendingAuth(existingAccount.type, existingAccount.label)),
    onOpenSettings: () => {
      setSettingsActiveTab('models');
      setSettingsOpen(true);
    },
  };
  return compact ? <CompactCard {...props} /> : <FullLayout {...props} />;
}
