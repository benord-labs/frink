import type { MessageSentEvent } from '../../../shared/types/analytics';
import { trpcClient } from '../trpc';

/**
 * Report a message sent from the UI. The main process owns the analytics client
 * and the opt-out, so the renderer never contacts PostHog itself.
 */
export function trackMessageSent(event: MessageSentEvent) {
  void trpcClient.analytics.messageSent.mutate(event).catch(() => {});
}
