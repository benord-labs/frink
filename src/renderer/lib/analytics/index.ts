import type { AiProviderId } from '../../../shared/lib/ai-providers';
import type { MessageSentEvent } from '../../../shared/types/analytics';
import { trpcClient } from '../trpc';

/**
 * Report a message sent from the UI. The main process owns the analytics client
 * and the opt-out, so the renderer never contacts PostHog itself.
 */
export function trackMessageSent(event: MessageSentEvent) {
  void trpcClient.analytics.messageSent.mutate(event).catch(() => {});
}

/** Report a connect page left without connecting an account. */
export function trackAccountConnectCancelled(provider: AiProviderId) {
  void trpcClient.analytics.accountConnectCancelled
    .mutate({ provider, reason: 'cancelled' })
    .catch(() => {});
}
