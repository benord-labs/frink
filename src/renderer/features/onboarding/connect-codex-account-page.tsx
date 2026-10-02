import openaiLogo from '@iconify-icons/ri/openai-fill';
import { iconifyComponent } from '@/lib/utils/iconify-component';
import { DETECTION_QUERY_OPTIONS, useConnectAccountFlow } from '../../hooks/useConnectAccountFlow';
import { trpc } from '../../lib/trpc';
import { ConnectAccountShell, connectFlowProps } from './connect-account-shell';

const CodexIcon = iconifyComponent(openaiLogo);

const CODEX_AUTH_COMMAND = 'codex login';

/**
 * Connect a Codex login as a passthrough account.
 *
 * - No token is stored in Frink. The `codex` CLI owns its credential (machine-local
 *   `~/.codex`); we only read identity metadata to label the row.
 * - One passthrough per machine (matches codex's single-source auth).
 */
export function ConnectCodexAccountPage() {
  const detectionQuery = trpc.claudeCode.detectCodexAccount.useQuery(
    undefined,
    DETECTION_QUERY_OPTIONS,
  );
  const connectMutation = trpc.claudeCode.connectCodexPassthrough.useMutation();

  const flow = useConnectAccountFlow({
    detectionQuery,
    connectMutation,
    buildConnectInput: (accountLabel) => ({ accountLabel }),
    deriveLabel: (detection) =>
      detection.available ? (detection.email ?? detection.displayName ?? 'OpenAI') : null,
    successMessage: (isReauthFlow) =>
      isReauthFlow ? 'OpenAI account reconnected' : 'OpenAI account connected',
  });

  const { detection } = flow;

  return (
    <ConnectAccountShell
      providerIcon={<CodexIcon className="w-6 h-6 text-background" />}
      providerIconBgClassName="bg-foreground"
      providerName="OpenAI"
      authCommand={CODEX_AUTH_COMMAND}
      headerDescription="Uses your Codex sign-in on this computer. No token is stored in Frink."
      detectionAvailable={detection?.available === true}
      detectionEmail={detection?.available ? detection.email : null}
      detectionHint={detection && !detection.available ? detection.hint : null}
      {...connectFlowProps(flow)}
    />
  );
}
