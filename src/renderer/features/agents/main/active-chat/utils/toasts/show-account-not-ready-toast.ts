import { toast } from 'sonner';
import type { PendingAccountAuthState } from '../../../../../../lib/atoms';

/** Default copy when blocking **send** from the active chat composer (and queue path). */
export const ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND =
  'Connect a Claude account or add an API key to send.';

/** Copy when blocking **new chat** creation from the new-chat composer. */
export const ACCOUNT_NOT_READY_TOAST_MESSAGE_START_CHAT =
  'Connect a Claude account or add an API key to start a chat.';

export type UnauthAccountForSend =
  | { label: string; type: 'claude-code' | 'codex' }
  | null
  | undefined;

export type ShowAccountNotReadyToastOptions = {
  /** Defaults to {@link ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND}. */
  message?: string;
};

/**
 * Shown when the user tries to send but no usable Claude/API execution account is ready.
 * Action routes into the connect (add) or reconnect (reauth) flow.
 */
export function showAccountNotReadyToast(
  unauthAccount: UnauthAccountForSend,
  setPendingAccountAuth: (value: PendingAccountAuthState) => void,
  options?: ShowAccountNotReadyToastOptions,
): void {
  const message = options?.message ?? ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND;
  toast.error(message, {
    action: {
      label: unauthAccount ? 'Reconnect' : 'Connect',
      onClick: () =>
        setPendingAccountAuth(
          unauthAccount
            ? {
                mode: 'reauth',
                accountLabel: unauthAccount.label,
                returnToSettings: false,
                provider: unauthAccount.type === 'codex' ? 'codex' : undefined,
              }
            : { mode: 'add', accountLabel: '', returnToSettings: false },
        ),
    },
  });
}

/**
 * `refetchInterval` for the account-gate queries: poll while blocked. `getResolvedAccount`
 * re-probes a flagged passthrough row main-side, so logging back into `claude` unblocks
 * sends within seconds, without a button.
 */
export const accountGateRefetchInterval = (query: {
  state: { data?: { isAuthenticated: boolean } | null };
}): number | false => (query.state.data?.isAuthenticated === false ? 10_000 : false);
