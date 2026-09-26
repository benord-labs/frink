import crypto from 'node:crypto';
import { standardWebhooksKey } from '../../integrations/webhook-secret';
import type { WebhookHeaders } from '../extractors/types';
import { getWebhookHeader } from '../extractors/utils';

/** A delivery outside this window is a replay; the reference verifiers use the same 5 minutes. */
const TOLERANCE_SECONDS = 5 * 60;

/** `missing` = the sender set no signature at all; `invalid` = it set one that does not verify. */
export type SignatureVerdict = 'ok' | 'missing' | 'invalid';

function signBody(hexSecret: string, id: string, timestamp: string, rawBody: string): Buffer {
  return crypto
    .createHmac('sha256', standardWebhooksKey(hexSecret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();
}

/** The three headers a Standard Webhooks sender sets, so a locally made sample verifies for real. */
export function standardWebhooksHeaders(
  hexSecret: string,
  id: string,
  rawBody: string,
  nowMs = Date.now(),
): WebhookHeaders {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signBody(hexSecret, id, timestamp, rawBody).toString('base64')}`,
  };
}

/** Standard Webhooks: `webhook-signature` carries space-separated `v1,<base64 HMAC-SHA256>` entries
 * over id.timestamp.body, keyed by the secret's bytes. Any entry matching passes, so keys can rotate. */
export function verifyStandardWebhooks(
  headers: WebhookHeaders,
  hexSecret: string,
  rawBody: string,
  nowMs = Date.now(),
): SignatureVerdict {
  const id = getWebhookHeader(headers, 'webhook-id');
  const timestamp = getWebhookHeader(headers, 'webhook-timestamp');
  const signatures = getWebhookHeader(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) return 'missing';

  const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (Number.isNaN(skewSeconds) || skewSeconds > TOLERANCE_SECONDS) return 'invalid';

  const expected = signBody(hexSecret, id, timestamp, rawBody);
  const matched = signatures.split(' ').some((entry) => {
    const [version, encoded = ''] = entry.split(',');
    const given = Buffer.from(encoded, 'base64');
    return (
      version === 'v1' &&
      given.length === expected.length &&
      crypto.timingSafeEqual(given, expected)
    );
  });
  return matched ? 'ok' : 'invalid';
}
