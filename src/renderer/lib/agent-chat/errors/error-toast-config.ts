/**
 * Error-category registry for chat execution failures: what the user sees (toast copy) and
 * whether a failed turn may offer a persisted Retry. Categories originate on the socket
 * ErrorPayload (stamped in main, e.g. RATE_LIMIT_SDK, FLOW_RUN_ENDED) or are derived
 * renderer-side from error text; an unknown category falls through to generic handling.
 * The rollback-vs-keep classification for these categories lives in
 * main/active-chat/utils/execution-error-classification.ts.
 */
// biome-ignore-all lint/style/useNamingConvention: keys are the wire error categories main stamps on ErrorPayload — renaming them is a cross-process contract change, not a style fix.
import { trpcClient } from '../../trpc';

export const ERROR_TOAST_CONFIG: Record<
  string,
  {
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
    /** Stable toast id: repeated errors of this category replace one toast instead of stacking. */
    toastId?: string;
  }
> = {
  AUTH_FAILED_SDK: {
    title: 'Not logged in',
    description: "Run 'claude login' in your terminal to authenticate",
    action: {
      label: 'Copy command',
      onClick: () => navigator.clipboard.writeText('claude login'),
    },
  },
  INVALID_API_KEY_SDK: {
    title: 'Invalid API key',
    description: 'Your Claude API key is invalid. Check your CLI configuration.',
  },
  RATE_LIMIT_SDK: {
    title: 'Session limit reached',
    description: "You've hit the Claude Code usage limit.",
    action: {
      label: 'View usage',
      onClick: () => trpcClient.external.openExternal.mutate('https://claude.ai/settings/usage'),
    },
  },
  OVERLOADED_SDK: {
    title: 'Claude is busy',
    description: 'The service is overloaded. Please try again in a few moments.',
  },
  PROCESS_CRASH: {
    title: 'Claude crashed',
    description:
      'The Claude process exited unexpectedly. Try sending your message again or rollback.',
  },
  NETWORK_ERROR: {
    title: 'Network error',
    description: 'Check your internet connection and try again.',
  },
  MACHINE_OFFLINE: {
    title: 'Machine offline',
    description: 'The machine with this project is not currently available.',
  },
  SOCKET_DISCONNECTED: {
    title: 'Connection lost',
    description: 'Lost connection to the socket server. Reconnecting...',
  },
  MESSAGE_TIMEOUT: {
    title: 'Message send timeout',
    description:
      'Your message took too long to send. This may be due to network issues or the server being unavailable.',
  },
  SOCKET_NOT_CONNECTED: {
    title: 'Not connected',
    description: 'Cannot send message - socket server is not connected. Please check your network.',
  },
  // Main settled the turn but its prompt never reached the agent (sc-3666). The message is
  // persisted and shown, so Retry re-sends it; there is nothing to roll back.
  MESSAGE_NOT_DELIVERED: {
    title: 'Message not delivered',
    description: "The agent didn't receive your message. Use Retry to send it again.",
  },
  FLOW_RUN_ENDED: {
    title: 'This flow run has ended',
    description: 'Use Continue or Retry above the composer to pick this flow back up.',
    toastId: 'flow-run-ended',
  },
  FLOW_RUN_RESUMING: {
    title: 'Flow run re-admitting',
    description:
      'Your message will continue this run — the agent picks up where it left off once the run is re-admitted.',
    toastId: 'flow-run-resuming',
  },
  LOGIN_REMOVED: {
    title: "This chat's login was removed",
    description: 'Retry the chat with another login, or add one.',
    toastId: 'login-removed',
  },
};

/** Per-sub-chat dedup id for a category's toast: repeats replace, sibling chats don't collide. */
export function toastDedupId(
  config: { toastId?: string } | undefined,
  subChatId: string,
): { id?: string } {
  return config?.toastId ? { id: `${config.toastId}:${subChatId}` } : {};
}

const NON_RETRYABLE_CHAT_ERROR_CATEGORIES = new Set([
  'AUTH_FAILED_SDK',
  'INVALID_API_KEY_SDK',
  // A send declined because the flow run already ended can only fail identically on retry;
  // recovery is the interrupted-run controls (Continue / Retry), not a resend.
  'FLOW_RUN_ENDED',
  // Decline-and-convert: the message is already the continuation payload — the re-admitted
  // run delivers it; a resend would fail identically and then double-deliver.
  'FLOW_RUN_RESUMING',
]);

export function shouldPersistChatRetry(category: string): boolean {
  return !NON_RETRYABLE_CHAT_ERROR_CATEGORIES.has(category);
}
