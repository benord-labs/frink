import crypto from 'node:crypto';
import type { WebhookPayloadSpec } from '../../integrations/types';
import type { WebhookHeaders } from '../extractors/types';
import { getWebhookHeader } from '../extractors/utils';
import type { SignatureVerdict } from './standard-webhooks';

const SIGNATURES = {
  square: { header: 'x-square-hmacsha256-signature', algorithm: 'sha256', encoding: 'base64' },
  vercel: { header: 'x-vercel-signature', algorithm: 'sha1', encoding: 'hex' },
  sentry: { header: 'sentry-hook-signature', algorithm: 'sha256', encoding: 'hex' },
} as const;
type VendorSignature = keyof typeof SIGNATURES;

export function isVendorSignature(
  signature: WebhookPayloadSpec['signature'],
): signature is VendorSignature {
  return signature === 'square' || signature === 'vercel' || signature === 'sentry';
}

/** Square includes the registered URL; Vercel and Sentry sign only the unmodified body. */
export function signVendorWebhook(
  signature: VendorSignature,
  secret: string,
  notificationUrl: string,
  rawBody: string,
): string {
  const spec = SIGNATURES[signature];
  return crypto
    .createHmac(spec.algorithm, secret)
    .update((signature === 'square' ? notificationUrl : '') + rawBody)
    .digest(spec.encoding);
}

export function vendorSignatureHeaders(
  signature: VendorSignature,
  secret: string,
  notificationUrl: string,
  rawBody: string,
): WebhookHeaders {
  return {
    [SIGNATURES[signature].header]: signVendorWebhook(signature, secret, notificationUrl, rawBody),
  };
}

export function verifyVendorWebhook(
  signature: VendorSignature,
  headers: WebhookHeaders,
  secret: string,
  notificationUrl: string,
  rawBody: string,
): SignatureVerdict {
  const header = getWebhookHeader(headers, SIGNATURES[signature].header);
  if (!header) return 'missing';
  const expected = Buffer.from(signVendorWebhook(signature, secret, notificationUrl, rawBody));
  const actual = Buffer.from(header);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
    ? 'ok'
    : 'invalid';
}
