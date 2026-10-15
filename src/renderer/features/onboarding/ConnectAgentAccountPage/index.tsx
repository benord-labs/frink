import { Button } from '@benord-labs/frink-primitives';
import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { aiProviderMark } from '@/components/AiProviderMark';
import { ProviderPreviewTag } from '@/components/ProviderPreviewTag';
import {
  AI_PROVIDERS,
  type AiProviderId,
  isInstalledAgent,
} from '../../../../shared/lib/ai-providers';
import { useConnectAccountFlow } from '../../../hooks/useConnectAccountFlow';
import { BUTTON_SHADOW } from '../../../lib/button-shadow';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import {
  ConnectAccountShell,
  connectFlowProps,
  PRIMARY_CTA,
  TerminalCommand,
} from '../connect-account-shell';

/** Why an agent can't connect: not installed and how to install it, or the launch's own reason. */
function agentNotFound(
  row: { name: string; installHint: string },
  missed: { reason: string; missing?: true },
  action?: ReactElement,
) {
  if (missed.missing) {
    const install = <TerminalCommand>{row.installHint}</TerminalCommand>;
    return {
      title: `${row.name} isn't installed.`,
      detail: <>To install it, run {install} in Terminal.</>,
    };
  }
  // The first sentence is the heading and the rest, if any, its detail.
  const [, title = missed.reason, detail] = /^(.+?\.)\s+(.+)$/s.exec(missed.reason) ?? [];
  return { title, detail, action };
}

/** A found agent's own sign-in, run in Terminal; Cursor's is the Sign in button instead. */
function agentLoginNote(row: { runtime: string; name: string; signInHint: string }) {
  if (row.runtime === 'cursor') return undefined;
  return (
    <span className="block text-sm">
      {row.runtime === 'copilot'
        ? `${row.name} needs you signed in. If you aren't yet, run `
        : `Free ${row.name} models work right away. To use your own providers, run `}
      <TerminalCommand>{row.signInHint}</TerminalCommand> in Terminal.
    </span>
  );
}

/** Starts Cursor's own sign-in in the browser, then checks again; Frink never sees the key. */
function CursorSignIn({ label, onSignedIn }: { label: string; onSignedIn: () => void }) {
  const signIn = trpc.agentAccounts.signIn.useMutation({ onSuccess: onSignedIn });
  return (
    <div className="space-y-2">
      <Button
        onClick={() => signIn.mutate({ type: 'cursor' })}
        className={cn(PRIMARY_CTA, BUTTON_SHADOW)}
      >
        {signIn.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Continue in your browser
          </>
        ) : (
          label
        )}
      </Button>
      {signIn.error && (
        <p role="alert" className="text-sm text-destructive">
          {signIn.error.message}
        </p>
      )}
    </div>
  );
}

/** The page's promise about where the sign-in lives. */
function signInSource(row: { runtime: string; name: string }, isAgent: boolean): string {
  if (row.runtime === 'cursor') return 'Uses your own Cursor sign-in.';
  return isAgent
    ? `Uses the ${row.name} installed on this computer.`
    : 'Uses your Codex sign-in on this computer.';
}

/**
 * Connects an AI provider that keeps its own sign-in on this computer: OpenAI through Codex, or an
 * agent Frink runs from the user's own install. Frink stores no token for any of them.
 */
export function ConnectAgentAccountPage({
  provider,
}: {
  provider: Exclude<AiProviderId, 'claude-code'>;
}): ReactElement {
  const row = AI_PROVIDERS[provider];
  const isAgent = isInstalledAgent(row);
  const Mark = aiProviderMark(provider);
  const detectionQuery = trpc.agentAccounts.detect.useQuery(
    { type: provider },
    { refetchOnWindowFocus: true },
  );
  const connectMutation = trpc.agentAccounts.connect.useMutation();

  const flow = useConnectAccountFlow({
    detectionQuery,
    connectMutation,
    buildConnectInput: (accountLabel) => ({ type: provider, accountLabel }),
    deriveLabel: (detection) =>
      detection.available ? (detection.email ?? detection.displayName ?? row.name) : null,
    successMessage: (isReauthFlow) =>
      `${row.name} account ${isReauthFlow ? 'reconnected' : 'connected'}`,
  });

  const { detection } = flow;
  const found = detection?.available ? detection : undefined;
  const missed = detection && !detection.available ? detection : undefined;
  const refetch = () => void detectionQuery.refetch();

  return (
    <ConnectAccountShell
      providerIcon={
        <Mark className={isAgent ? 'w-6 h-6 text-foreground' : 'w-6 h-6 text-background'} />
      }
      providerIconBgClassName={isAgent ? 'bg-muted' : 'bg-foreground'}
      providerName={row.name}
      providerTag={<ProviderPreviewTag provider={provider} />}
      authCommand={isAgent ? row.signInHint : 'codex login'}
      headerDescription={`${signInSource(row, isAgent)} No token is stored in Frink.`}
      foundTitle={found?.version ? `${row.name} ${found.version} found.` : undefined}
      loginFoundNote={isAgent ? agentLoginNote(row) : undefined}
      notFound={
        isAgent && missed
          ? agentNotFound(
              row,
              missed,
              missed.signedOut ? (
                <CursorSignIn label={row.signInHint} onSignedIn={refetch} />
              ) : undefined,
            )
          : undefined
      }
      detectionAvailable={Boolean(found)}
      detectionEmail={found?.email}
      detectionHint={isAgent ? null : missed?.reason}
      {...connectFlowProps(flow)}
    />
  );
}
