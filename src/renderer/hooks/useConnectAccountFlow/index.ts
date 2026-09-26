import { useAtom, useSetAtom } from 'jotai';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  anthropicOnboardingCompletedAtom,
  pendingAccountAuthAtom,
} from '../../lib/atoms';
import { trpc } from '../../lib/trpc';

export type ConnectFlowState = 'idle' | 'connecting' | 'error';

/** Minimal shape of the detection `useQuery` result both connect pages depend on. */
type DetectionQuery<TDetection> = {
  data: TDetection | undefined;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
};

/** Minimal shape of the connect `useMutation` result both connect pages depend on. */
type ConnectMutation<TInput> = {
  mutateAsync: (input: TInput) => Promise<unknown>;
};

type UseConnectAccountFlowParams<TDetection, TInput> = {
  /** The provider's detection query result (Claude/Codex `detect*Account.useQuery(...)`). */
  detectionQuery: DetectionQuery<TDetection>;
  /** The provider's connect mutation result (Claude/Codex `connect*Passthrough.useMutation()`). */
  connectMutation: ConnectMutation<TInput>;
  /** Maps the (validated, trimmed) label + flow context to the provider-specific mutation input. */
  buildConnectInput: (
    label: string,
    ctx: { detection: TDetection | undefined; isReauthFlow: boolean },
  ) => TInput;
  /** Derives the default account label from detection when the user hasn't typed one. */
  deriveLabel: (detection: TDetection) => string | null;
  /** Connected/reconnected toast copy ("Claude account connected", etc.). */
  successMessage: (isReauthFlow: boolean) => string;
};

export type ConnectAccountFlow<TDetection> = {
  detection: TDetection | undefined;
  isLoading: boolean;
  flowState: ConnectFlowState;
  errorMessage: string | null;
  isReauthFlow: boolean;
  isRefreshing: boolean;
  accountLabel: string;
  setAccountLabel: (value: string) => void;
  handleBack: () => void;
  handleRefresh: () => Promise<void>;
  handleConnect: () => Promise<void>;
  dismissError: () => void;
};

/**
 * Shared connect/reconnect flow for the Claude and Codex passthrough pages.
 *
 * Owns the state + handlers both pages duplicated — flow state, account-label default,
 * the back/refresh/connect handlers, the `pendingAccountAuth`/settings/onboarding atom
 * wiring, and the `listAccounts`/`getResolvedAccount` invalidations on success. Providers
 * differ only in their detection/connect tRPC hooks, the mutation input, the label default,
 * and (for Claude) an extra pre-connect guard — all passed in via params.
 */
export function useConnectAccountFlow<TDetection, TInput>({
  detectionQuery,
  connectMutation,
  buildConnectInput,
  deriveLabel,
  successMessage,
}: UseConnectAccountFlowParams<TDetection, TInput>): ConnectAccountFlow<TDetection> {
  const [flowState, setFlowState] = useState<ConnectFlowState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const setAnthropicOnboardingCompleted = useSetAtom(anthropicOnboardingCompletedAtom);
  const [pendingAccountAuth, setPendingAccountAuth] = useAtom(pendingAccountAuthAtom);
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom);
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom);

  const [accountLabel, setAccountLabel] = useState(pendingAccountAuth?.accountLabel ?? '');

  const isReauthFlow = pendingAccountAuth?.mode === 'reauth';
  const shouldReturnToSettings = pendingAccountAuth?.returnToSettings === true;

  const trpcUtils = trpc.useUtils();
  const detection = detectionQuery.data;

  // Default the label from the detected identity when the user hasn't typed anything.
  useEffect(() => {
    if (accountLabel || !detection) return;
    const derived = deriveLabel(detection);
    if (derived) setAccountLabel(derived);
  }, [detection, accountLabel, deriveLabel]);

  const returnToSettingsIfRequested = () => {
    if (shouldReturnToSettings) {
      setSettingsActiveTab('models');
      setSettingsOpen(true);
    }
  };

  const handleBack = () => {
    setPendingAccountAuth(null);
    returnToSettingsIfRequested();
    setAnthropicOnboardingCompleted(true);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setFlowState('idle');
    setErrorMessage(null);
    await detectionQuery.refetch();
    setIsRefreshing(false);
  };

  const handleConnect = async () => {
    const label = accountLabel.trim();
    if (!label) {
      setErrorMessage('Please enter an account label.');
      setFlowState('error');
      return;
    }

    setFlowState('connecting');
    setErrorMessage(null);

    try {
      await connectMutation.mutateAsync(buildConnectInput(label, { detection, isReauthFlow }));
      await Promise.all([
        trpcUtils.claudeCode.listAccounts.invalidate(),
        trpcUtils.claudeCode.getResolvedAccount.invalidate(),
      ]);
      setPendingAccountAuth(null);
      returnToSettingsIfRequested();
      toast.success(successMessage(isReauthFlow));
      setAnthropicOnboardingCompleted(true);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect account');
      setFlowState('error');
    }
  };

  const dismissError = () => {
    setFlowState('idle');
    setErrorMessage(null);
  };

  return {
    detection,
    isLoading: detectionQuery.isLoading,
    flowState,
    errorMessage,
    isReauthFlow,
    isRefreshing,
    accountLabel,
    setAccountLabel,
    handleBack,
    handleRefresh,
    handleConnect,
    dismissError,
  };
}
