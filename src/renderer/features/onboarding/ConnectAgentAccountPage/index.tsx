import type { ReactElement } from 'react';
import { aiProviderMark } from '@/components/AiProviderMark';
import {
  AI_PROVIDERS,
  type AiProviderId,
  isInstalledAgent,
} from '../../../../shared/lib/ai-providers';
import { useConnectAccountFlow } from '../../../hooks/useConnectAccountFlow';
import { trpc } from '../../../lib/trpc';
import { ConnectAccountShell, connectFlowProps, TerminalCommand } from '../connect-account-shell';

/** Why an agent can't connect: not installed and how to install it, or the launch's own reason. */
function agentNotFound(
  row: { name: string; installHint: string },
  missed: { reason: string; missing?: true },
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
  return { title, detail };
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

  return (
    <ConnectAccountShell
      providerIcon={
        <Mark className={isAgent ? 'w-6 h-6 text-foreground' : 'w-6 h-6 text-background'} />
      }
      providerIconBgClassName={isAgent ? 'bg-muted' : 'bg-foreground'}
      providerName={row.name}
      authCommand={isAgent ? row.signInHint : 'codex login'}
      headerDescription={
        isAgent
          ? `Uses the ${row.name} installed on this computer. No token is stored in Frink.`
          : 'Uses your Codex sign-in on this computer. No token is stored in Frink.'
      }
      foundTitle={found?.version ? `${row.name} ${found.version} found.` : undefined}
      loginFoundNote={
        isAgent ? (
          <span className="block text-sm">
            {row.runtime === 'copilot'
              ? `${row.name} needs you signed in. If you aren't yet, run `
              : `Free ${row.name} models work right away. To use your own providers, run `}
            <TerminalCommand>{row.signInHint}</TerminalCommand> in Terminal.
          </span>
        ) : undefined
      }
      notFound={isAgent && missed ? agentNotFound(row, missed) : undefined}
      detectionAvailable={Boolean(found)}
      detectionEmail={found?.email}
      detectionHint={isAgent ? null : missed?.reason}
      {...connectFlowProps(flow)}
    />
  );
}
