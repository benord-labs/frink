import crypto from 'node:crypto';
import { z } from 'zod';
import type { WebhookHeaders } from '../extractors/types';
import { getWebhookHeader } from '../extractors/utils';
import type { SignatureVerdict } from './standard-webhooks';

const NOTION_PREFIX = 'sha256=';

export const notionChallenge = z
  .object({ verification_token: z.string().min(20).max(512) })
  .strict();

/** Notion sends `sha256=<hex HMAC-SHA256 of the raw body>`, keyed by the subscription's
 * verification token. A malformed hex string simply fails the comparison. */
export function verifyNotionSignature(
  headers: WebhookHeaders,
  secret: string,
  rawBody: string,
): SignatureVerdict {
  const signature = getWebhookHeader(headers, 'x-notion-signature');
  if (!signature) return 'missing';
  if (!signature.startsWith(NOTION_PREFIX)) return 'invalid';
  const given = Buffer.from(signature.slice(NOTION_PREFIX.length).toLowerCase());
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
    ? 'ok'
    : 'invalid';
}

/** Cloudflare authenticates a configured destination with its fixed secret header. */
export function verifySecretHeader(
  headers: WebhookHeaders,
  name: string,
  secret: string,
): SignatureVerdict {
  const header = getWebhookHeader(headers, name);
  if (!header) return 'missing';
  const given = Buffer.from(header);
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
    ? 'ok'
    : 'invalid';
}
