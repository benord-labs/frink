import { describe, expect, it } from 'vitest';
import { standardWebhooksKey, standardWebhooksSecret } from './webhook-secret';

const HEX_SECRET = '00ff10a5'.repeat(8);

describe('standard webhooks secret encoding', () => {
  it('decodes the stored hex into its 32 bytes', () => {
    expect(standardWebhooksKey(HEX_SECRET)).toEqual(
      Uint8Array.from(Buffer.from(HEX_SECRET, 'hex')),
    );
  });

  it('hands the vendor whsec_ + base64 of those same bytes', () => {
    const secret = standardWebhooksSecret(HEX_SECRET);
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(Buffer.from(secret.slice('whsec_'.length), 'base64')).toEqual(
      Buffer.from(HEX_SECRET, 'hex'),
    );
  });
});
