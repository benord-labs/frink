import { describe, expect, it } from 'vitest';
import { signVendorWebhook, verifyVendorWebhook, vendorSignatureHeaders } from './vendor-hmac';
import { importedWebhookUrl } from '../../integrations/webhook-secret';

const url = 'https://example.com/webhook';
const body = '{"hello":"world"}';
const signature = '2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=';

describe('Square webhook signatures', () => {
  it('matches the official Square documentation signature vector', () => {
    expect(signVendorWebhook('square', 'asdf1234', url, body)).toBe(signature);
    expect(
      verifyVendorWebhook(
        'square',
        { 'x-square-hmacsha256-signature': signature },
        'asdf1234',
        url,
        body,
      ),
    ).toBe('ok');
  });
  it('rejects a missing signature, different URL, key, body or malformed header', () => {
    expect(verifyVendorWebhook('square', {}, 'asdf1234', url, body)).toBe('missing');
    const headers = { 'x-square-hmacsha256-signature': signature };
    expect(verifyVendorWebhook('square', headers, 'wrong', url, body)).toBe('invalid');
    expect(verifyVendorWebhook('square', headers, 'asdf1234', url + '/', body)).toBe('invalid');
    expect(verifyVendorWebhook('square', headers, 'asdf1234', url, body + ' ')).toBe('invalid');
    expect(
      verifyVendorWebhook(
        'square',
        { 'x-square-hmacsha256-signature': 'é'.repeat(44) },
        'asdf1234',
        url,
        body,
      ),
    ).toBe('invalid');
  });
  it('only reads an imported Square notification URL, at whichever address it was configured', () => {
    expect(importedWebhookUrl('square', 'manual:square:' + url)).toBe(url);
    expect(importedWebhookUrl('square', null)).toBeUndefined();
    expect(importedWebhookUrl('square', 'manual:clickup:' + url)).toBeUndefined();
    // A machine answering on its own loopback door has an http address and is no less its owner's.
    expect(importedWebhookUrl('square', 'manual:square:http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080',
    );
    expect(importedWebhookUrl('square', 'manual:square:not-a-url')).toBeUndefined();
  });
});

it.each([
  ['vercel', 'x-vercel-signature', 'baa06f6235863983a3c1eb99d9b16f5c391c95b4'],
  [
    'sentry',
    'sentry-hook-signature',
    '94ac0e7332354ed289b045e70b1c7d4c130d04e1efba153ce3c03b49aeb889af',
  ],
] as const)('verifies %s body signatures and rejects changes', (provider, header, signature) => {
  const headers = { [header]: signature };
  expect(signVendorWebhook(provider, 'asdf1234', url, body)).toBe(signature);
  expect(vendorSignatureHeaders(provider, 'asdf1234', url, body)).toEqual(headers);
  expect(verifyVendorWebhook(provider, headers, 'asdf1234', url, body)).toBe('ok');
  expect(verifyVendorWebhook(provider, {}, 'asdf1234', url, body)).toBe('missing');
  expect(verifyVendorWebhook(provider, headers, 'wrong', url, body)).toBe('invalid');
  expect(verifyVendorWebhook(provider, headers, 'asdf1234', url, body + ' ')).toBe('invalid');
});
