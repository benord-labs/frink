import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyNotionSignature, verifySecretHeader } from './notion';

function sign(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

describe('Notion webhook signatures', () => {
  it('accepts the signature Notion produces for these exact bytes', () => {
    const body = '{"type":"page.created"}';
    const fromNotion = 'sha256=3da52958019702adfdbe8c3c015fe9d221c227020aaac5525dce3b1b3ec1ed8e';
    expect(sign('secret-test', body)).toBe(fromNotion);
    expect(verifyNotionSignature({ 'x-notion-signature': fromNotion }, 'secret-test', body)).toBe(
      'ok',
    );
  });

  it('checks the original raw bytes', () => {
    const body = '{"type":"page.created"}';
    const signature = sign('secret-test', body);
    expect(verifyNotionSignature({ 'x-notion-signature': signature }, 'secret-test', body)).toBe(
      'ok',
    );
    expect(verifyNotionSignature({ 'x-notion-signature': signature }, 'wrong', body)).toBe(
      'invalid',
    );
    expect(
      verifyNotionSignature({ 'x-notion-signature': signature }, 'secret-test', `${body}\n`),
    ).toBe('invalid');
    expect(verifyNotionSignature({ 'x-notion-signature': 'nonsense' }, 'secret-test', body)).toBe(
      'invalid',
    );
    expect(verifyNotionSignature({}, 'secret-test', body)).toBe('missing');
  });
});

describe('Cloudflare destination header', () => {
  it('requires an exact constant-time secret match', () => {
    expect(verifySecretHeader({}, 'cf-webhook-auth', 'secret')).toBe('missing');
    expect(verifySecretHeader({ 'cf-webhook-auth': 'secret' }, 'cf-webhook-auth', 'secret')).toBe(
      'ok',
    );
    expect(verifySecretHeader({ 'cf-webhook-auth': 'secrex' }, 'cf-webhook-auth', 'secret')).toBe(
      'invalid',
    );
    expect(verifySecretHeader({ 'cf-webhook-auth': 'sécre' }, 'cf-webhook-auth', 'secret')).toBe(
      'invalid',
    );
  });
});
