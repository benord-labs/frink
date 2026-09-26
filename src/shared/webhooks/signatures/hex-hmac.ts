import crypto from 'node:crypto';
import type { WebhookHeaders } from '../extractors/types';
import { getWebhookHeader } from '../extractors/utils';
import type { SignatureVerdict } from './standard-webhooks';

/** A named header carries a bare hex HMAC-SHA256 of the raw body, keyed by the endpoint secret string.
 * The row names the header, so a new vendor of this shape is a catalog row and never a file. */
export function signHexHmac(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyHexHmacHeader(
  headers: WebhookHeaders,
  headerName: string,
  secret: string,
  rawBody: string,
): SignatureVerdict {
  const header = getWebhookHeader(headers, headerName)?.trim();
  if (!header) return 'missing';
  const given = Buffer.from(header);
  const expected = Buffer.from(signHexHmac(secret, rawBody));
  // Byte lengths, not string lengths: timingSafeEqual throws on a mismatch, and a non-ASCII header can match the character count.
  if (given.length !== expected.length) return 'invalid';
  return crypto.timingSafeEqual(given, expected) ? 'ok' : 'invalid';
}
