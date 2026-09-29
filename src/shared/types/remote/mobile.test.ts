import { describe, expect, it } from 'vitest';
import {
  MOBILE_PAIRING_LINK,
  mobilePairingFields,
  mobilePairingLink,
  mobilePairingSchema,
} from './mobile';

const pairing = {
  version: 2 as const,
  url: 'https://studio-mac.tail1234.ts.net:8443/',
  code: `${'a'.repeat(41)}-_`,
};

describe('mobilePairingLink', () => {
  it('round-trips through the reader the phone uses', () => {
    const link = mobilePairingLink(pairing);
    expect(link.startsWith(`${MOBILE_PAIRING_LINK}?`)).toBe(true);
    expect(mobilePairingSchema.parse(mobilePairingFields(link))).toEqual(pairing);
  });

  it('encodes the address so it survives as one query value', () => {
    expect(mobilePairingLink(pairing)).toBe(
      `frink-mobile://pair?url=https%3A%2F%2Fstudio-mac.tail1234.ts.net%3A8443%2F&code=${pairing.code}&v=2`,
    );
  });
});
