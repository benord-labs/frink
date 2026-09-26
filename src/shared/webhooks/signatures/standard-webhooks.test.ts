import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { standardWebhooksSecret } from '../../integrations/webhook-secret';
import { verifyStandardWebhooks } from './standard-webhooks';

const HEX_SECRET = crypto.randomBytes(32).toString('hex');
const OTHER_HEX_SECRET = crypto.randomBytes(32).toString('hex');
const BODY = JSON.stringify({ event: { event: 'checkout_completed' } });
const NOW_MS = Date.parse('2026-09-07T10:00:00.000Z');

/** Signs the way PostHog does: base64-decode the pasted `whsec_` secret and HMAC id.timestamp.body. */
function sign(pastedSecret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(pastedSecret.slice('whsec_'.length), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function headers(overrides: Record<string, string | undefined> = {}) {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  return {
    'webhook-id': 'msg_1',
    'webhook-timestamp': timestamp,
    'webhook-signature': sign(standardWebhooksSecret(HEX_SECRET), 'msg_1', timestamp, BODY),
    ...overrides,
  };
}

describe('verifyStandardWebhooks', () => {
  it('accepts a delivery signed with the secret the vendor was handed', () => {
    expect(verifyStandardWebhooks(headers(), HEX_SECRET, BODY, NOW_MS)).toBe('ok');
  });

  it('rejects a delivery signed with another secret', () => {
    expect(verifyStandardWebhooks(headers(), OTHER_HEX_SECRET, BODY, NOW_MS)).toBe('invalid');
  });

  it('rejects a signature over a different body', () => {
    expect(verifyStandardWebhooks(headers(), HEX_SECRET, `${BODY} `, NOW_MS)).toBe('invalid');
  });

  it('rejects a timestamp older than five minutes, even when the signature over it is right', () => {
    const stale = String(Math.floor(NOW_MS / 1000) - 5 * 60 - 1);
    const stamped = headers({
      'webhook-timestamp': stale,
      'webhook-signature': sign(standardWebhooksSecret(HEX_SECRET), 'msg_1', stale, BODY),
    });
    expect(verifyStandardWebhooks(stamped, HEX_SECRET, BODY, NOW_MS)).toBe('invalid');
  });

  it('rejects a timestamp that is not a number', () => {
    expect(
      verifyStandardWebhooks(headers({ 'webhook-timestamp': 'soon' }), HEX_SECRET, BODY, NOW_MS),
    ).toBe('invalid');
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'reports a missing %s header as an unsigned delivery',
    (name) => {
      expect(verifyStandardWebhooks(headers({ [name]: undefined }), HEX_SECRET, BODY, NOW_MS)).toBe(
        'missing',
      );
    },
  );

  it('accepts a space-separated list when any entry matches (key rotation)', () => {
    const timestamp = String(Math.floor(NOW_MS / 1000));
    const rotated = `${sign(standardWebhooksSecret(OTHER_HEX_SECRET), 'msg_1', timestamp, BODY)} ${sign(standardWebhooksSecret(HEX_SECRET), 'msg_1', timestamp, BODY)}`;
    expect(
      verifyStandardWebhooks(headers({ 'webhook-signature': rotated }), HEX_SECRET, BODY, NOW_MS),
    ).toBe('ok');
  });

  it('ignores entries of another version', () => {
    const v1a = headers()['webhook-signature'].replace('v1,', 'v1a,');
    expect(
      verifyStandardWebhooks(headers({ 'webhook-signature': v1a }), HEX_SECRET, BODY, NOW_MS),
    ).toBe('invalid');
  });
});
