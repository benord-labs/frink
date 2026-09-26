import type { WebhookHeaders } from '../../../shared/webhooks/extractors/types';
import type { receiveWebhook } from '../../../shared/webhooks/receiver';

type ReceiverRequest = Parameters<typeof receiveWebhook>[0];

/** The address a delivery claims, whichever front door carried it. The claim is only a key into
 * this machine's own table; the row it finds decides which provider and which secret apply. */
export function receiverRequest(
  provider: string,
  id: string,
  headers: WebhookHeaders,
  method: string | undefined,
): ReceiverRequest {
  return { method, query: { provider, id }, headers };
}
