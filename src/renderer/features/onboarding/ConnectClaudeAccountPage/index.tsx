import claudeLogo from '@iconify-icons/simple-icons/claude';
import { type InAppSignIn, useInAppSignIn } from '@/lib/ai-providers/use-in-app-sign-in';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { useConnectAccountFlow } from '../../../hooks/useConnectAccountFlow';
import { trpc } from '../../../lib/trpc';
import { ConnectAccountShell, connectFlowProps } from '../connect-account-shell';
import { SignInWaitingCard } from '../SignInWaitingCard';

const ClaudeCodeIcon = iconifyComponent(claudeLogo);

/**
 * Connect a Claude Code login as a passthrough account.
 *
 * - Frink never reads or stores the token. Agents are pointed at your Claude CLI's own
 *   keychain login, so the CLI's normal rotation keeps them authenticated mid-run.
 * - One passthrough per machine, and exactly one keychain entry — the canonical,
 *   login-scoped one. There is no picker: a workspace-scoped entry would be unusable
 *   at spawn time.
 */
export function ConnectClaudeAccountPage() {
  // Typed up front: its callbacks read the query and flow declared below it.
  const signIn: InAppSignIn = useInAppSignIn({
    type: 'claude-code',
    recheck: async () => {
      const { data } = await detectionQuery.refetch();
      return data?.available ? data : null;
    },
    connect: (detection) => flow.handleConnect(detection),
  });
  const detectionQuery = trpc.claudeCode.detectClaudeAccount.useQuery(undefined, {
    // Each check reads the keychain, so a sign-in still in progress is left alone.
    refetchOnWindowFocus: !signIn.waiting,
  });
  const connectMutation = trpc.claudeCode.connectClaudePassthrough.useMutation();

  const flow = useConnectAccountFlow({
    detectionQuery,
    connectMutation,
    buildConnectInput: (accountLabel, { detection, isReauthFlow }) => {
      const sourcePath = detection?.available ? detection.sourcePath : undefined;
      // Connect is disabled without a detected login, but the shell hands `onConnect` to its
      // retry panel too, where a refetch or a sign-out can clear detection between render and
      // click. Fail loud here rather than POST an empty sourcePath (the previous `as string`
      // cast asserted a guarantee the button state alone could not make).
      if (!sourcePath) {
        throw new Error("Frink can't find your Claude login. Go back and sign in again.");
      }
      return {
        accountLabel,
        sourcePath,
        expectedEmail: detection?.available ? detection.email : undefined,
        // When the user arrived via the empty-state's "Reconnect" CTA, signal the procedure to
        // convert any same-label api-key/legacy row in place instead of rejecting on collision.
        reauth: isReauthFlow,
      };
    },
    deriveLabel: (detection) =>
      detection.available ? (detection.email ?? detection.displayName ?? null) : null,
    successMessage: (isReauthFlow) =>
      isReauthFlow ? 'Claude account reconnected' : 'Claude account connected',
  });

  const { detection } = flow;
  const hasLogin = Boolean(detection?.available && detection.sourcePath);

  return (
    <ConnectAccountShell
      providerIcon={<ClaudeCodeIcon className="w-6 h-6 text-white" />}
      providerIconBgClassName="bg-[#D97757]"
      providerName="Claude"
      headerDescription="Frink hands your agents your Claude Code login. Your Claude CLI keeps it fresh — Frink never reads or stores the token."
      loginFoundNote={
        <>
          On macOS you'll see a system prompt the first time Frink reads your Claude login. Click{' '}
          <strong>Always Allow</strong> so chat sends don't pause for it.
        </>
      }
      detectionAvailable={hasLogin}
      detectionEmail={detection?.available ? detection.email : null}
      detectionHint={detection && !detection.available ? detection.hint : null}
      notFound={{
        title: 'Sign in to Claude',
        action: (
          <SignInWaitingCard
            name="Claude"
            state={signIn.state}
            onStart={signIn.start}
            onCancel={signIn.cancel}
          />
        ),
      }}
      connectDisabled={!hasLogin}
      {...connectFlowProps(flow)}
    />
  );
}
