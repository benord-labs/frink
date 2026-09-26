import { Button, Input } from '@benord-labs/frink-primitives';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  RefreshCw,
  Terminal,
  Loader2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { FrinkLoadingLogo } from '../../components/ui/frink-loading-logo';
import type { ConnectAccountFlow, ConnectFlowState } from '../../hooks/useConnectAccountFlow';
import { BUTTON_SHADOW } from '../../lib/button-shadow';
import { cn } from '../../lib/utils';

const PRIMARY_CTA =
  'w-full min-h-[44px] bg-primary text-primary-foreground rounded-lg text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

type ConnectAccountShellProps = {
  /** Provider brand glyph rendered beside the Frink logo in the header. */
  providerIcon: ReactNode;
  /** Tailwind classes for the circular badge wrapping `providerIcon` (brand colour). */
  providerIconBgClassName: string;
  /** Human provider name used in the title/heading copy ("Claude" / "Codex"). */
  providerName: string;
  /** CLI command shown in the "no login detected" instructions (e.g. `codex login`). */
  authCommand: string;
  /** Sub-heading line under the title (provider-specific token-storage reassurance). */
  headerDescription: ReactNode;
  /** Optional copy inside the "login found" panel (e.g. the macOS keychain prompt note). */
  loginFoundNote?: ReactNode;

  /** Whether a usable login was detected on this machine. */
  detectionAvailable: boolean;
  /** Detected identity email (drives the "Connected to …" headline). */
  detectionEmail?: string | null;
  /** Optional diagnostic hint shown in the "no login detected" panel. */
  detectionHint?: string | null;
  /** True while the detection query is still resolving. */
  isLoading: boolean;

  flowState: ConnectFlowState;
  errorMessage: string | null;
  isReauthFlow: boolean;
  isConnecting: boolean;
  isRefreshing: boolean;
  /** Disables Connect beyond the shell's own label check (e.g. no keychain entry picked). */
  connectDisabled?: boolean;

  accountLabel: string;
  onAccountLabelChange: (value: string) => void;
  onBack: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onErrorDismiss: () => void;
};

function LoginFoundPanel({
  providerName,
  loginFoundNote,
  detectionEmail,
  isReauthFlow,
  isConnecting,
  accountLabel,
  connectDisabled,
  onConnect,
}: {
  providerName: string;
  loginFoundNote?: ReactNode;
  detectionEmail?: string | null;
  isReauthFlow: boolean;
  isConnecting: boolean;
  accountLabel: string;
  connectDisabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg border bg-[hsl(var(--status-online)/0.1)] border-[hsl(var(--status-online)/0.2)]">
        <div className={cn('flex items-center gap-2', loginFoundNote && 'mb-2')}>
          <CheckCircle2
            className="h-4 w-4 text-[hsl(var(--status-online-text))]"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">
            {detectionEmail ? `Connected to ${detectionEmail}` : `${providerName} login found`}
          </p>
        </div>
        {loginFoundNote && <p className="text-xs text-muted-foreground">{loginFoundNote}</p>}
      </div>

      <Button
        onClick={onConnect}
        disabled={isConnecting || !accountLabel.trim() || connectDisabled}
        className={cn(PRIMARY_CTA, 'disabled:cursor-not-allowed', BUTTON_SHADOW)}
      >
        {isConnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isReauthFlow ? (
          'Reconnect'
        ) : (
          'Connect'
        )}
      </Button>
    </div>
  );
}

function NoLoginPanel({
  providerName,
  authCommand,
  detectionHint,
  isRefreshing,
  onRefresh,
}: {
  providerName: string;
  authCommand: string;
  detectionHint?: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-muted/50 border border-border rounded-lg">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          <p className="text-sm font-medium">No {providerName} login detected</p>
        </div>
        <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
          <li>
            Open Terminal and run:{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] font-mono">
              {authCommand}
            </code>
          </li>
          <li>Complete the login in your browser</li>
          <li>Return here and click refresh</li>
        </ol>
        {detectionHint && <p className="text-xs text-muted-foreground mt-3">{detectionHint}</p>}
      </div>

      <Button
        onClick={onRefresh}
        disabled={isRefreshing}
        className={cn(PRIMARY_CTA, BUTTON_SHADOW)}
      >
        {isRefreshing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check for Login
          </>
        )}
      </Button>
    </div>
  );
}

function ErrorPanel({
  errorMessage,
  isConnecting,
  onErrorDismiss,
  onConnect,
}: {
  errorMessage: string;
  isConnecting: boolean;
  onErrorDismiss: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="space-y-4">
      <div
        role="alert"
        aria-live="assertive"
        className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg"
      >
        <div className="flex items-center gap-2 mb-2">
          <Terminal className="h-4 w-4 text-destructive" aria-hidden="true" />
          <p className="text-sm text-destructive font-medium">{errorMessage}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={onErrorDismiss}
          className="flex-1 min-h-[44px] rounded-lg"
        >
          Back
        </Button>
        <Button
          onClick={onConnect}
          disabled={isConnecting}
          className="flex-1 min-h-[44px] rounded-lg gap-2"
        >
          {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Retry'}
        </Button>
      </div>
    </div>
  );
}

/**
 * The shell props every provider page wires identically from the flow hook. Both pages
 * spread this instead of restating the same twelve passthroughs — they converged once the
 * Claude page lost its keychain picker, and a hand-copied list is exactly what drifts.
 */
export function connectFlowProps<TDetection>(flow: ConnectAccountFlow<TDetection>) {
  return {
    isLoading: flow.isLoading,
    flowState: flow.flowState,
    errorMessage: flow.errorMessage,
    isReauthFlow: flow.isReauthFlow,
    isConnecting: flow.flowState === 'connecting',
    isRefreshing: flow.isRefreshing,
    accountLabel: flow.accountLabel,
    onAccountLabelChange: flow.setAccountLabel,
    onBack: flow.handleBack,
    onConnect: flow.handleConnect,
    onRefresh: flow.handleRefresh,
    onErrorDismiss: flow.dismissError,
  };
}

/**
 * Presentational shell shared by the Claude and Codex connect/reconnect pages.
 *
 * Owns every structural element both providers duplicate — the draggable title bar,
 * back button, logo + provider-icon header, account-label input, the "login found"
 * panel + Connect button, the "no login detected" instructions + refresh button, and
 * the error/retry block — so the per-provider pages stay thin wrappers that only supply
 * their detection/connect wiring.
 */
export function ConnectAccountShell({
  providerIcon,
  providerIconBgClassName,
  providerName,
  authCommand,
  headerDescription,
  loginFoundNote,
  detectionAvailable,
  detectionEmail,
  detectionHint,
  isLoading,
  flowState,
  errorMessage,
  isReauthFlow,
  isConnecting,
  isRefreshing,
  connectDisabled = false,
  accountLabel,
  onAccountLabelChange,
  onBack,
  onConnect,
  onRefresh,
  onErrorDismiss,
}: ConnectAccountShellProps) {
  return (
    <div className="auth-atmosphere h-screen w-screen flex flex-col items-center justify-center bg-background select-none">
      {/* Draggable title bar */}
      <div
        className="fixed top-0 left-0 right-0 h-10"
        style={
          // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property name
          { WebkitAppRegion: 'drag' } as React.CSSProperties
        }
      />

      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        aria-label="Back"
        className="fixed top-12 left-4 h-11 w-11 rounded-full hover:bg-foreground/5"
        iconOnly
      >
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </Button>

      <div className="w-full max-w-[440px] space-y-6 px-4">
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-2 p-2 mx-auto w-max rounded-full border border-border">
            <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white">
              <FrinkLoadingLogo className="h-7 w-7" />
            </div>
            <div
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center',
                providerIconBgClassName,
              )}
            >
              {providerIcon}
            </div>
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold tracking-tight">
              {isReauthFlow
                ? `Reconnect ${providerName} Account`
                : `Connect ${providerName} Account`}
            </h1>
            <p className="text-sm text-muted-foreground">{headerDescription}</p>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="account-label" className="text-sm font-medium text-foreground">
            Account Label
          </label>
          <Input
            id="account-label"
            value={accountLabel}
            onChange={(e) => onAccountLabelChange(e.target.value)}
            placeholder="Work, Personal, etc."
          />
        </div>

        <div className="space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}

          {!isLoading && detectionAvailable && flowState !== 'error' && (
            <LoginFoundPanel
              providerName={providerName}
              loginFoundNote={loginFoundNote}
              detectionEmail={detectionEmail}
              isReauthFlow={isReauthFlow}
              isConnecting={isConnecting}
              accountLabel={accountLabel}
              connectDisabled={connectDisabled}
              onConnect={onConnect}
            />
          )}

          {!isLoading && !detectionAvailable && flowState !== 'error' && (
            <NoLoginPanel
              providerName={providerName}
              authCommand={authCommand}
              detectionHint={detectionHint}
              isRefreshing={isRefreshing}
              onRefresh={onRefresh}
            />
          )}

          {flowState === 'error' && errorMessage && (
            <ErrorPanel
              errorMessage={errorMessage}
              isConnecting={isConnecting}
              onErrorDismiss={onErrorDismiss}
              onConnect={onConnect}
            />
          )}
        </div>
      </div>
    </div>
  );
}
