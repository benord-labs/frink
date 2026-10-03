import { describe, expect, it } from 'vitest';
import {
  MOBILE_PAIRING_LINK,
  mobilePairingFields,
  mobilePairingLink,
  mobilePairingSchema,
} from './mobile';

const pairing = {
  version: 3 as const,
  relay: 'https://relay.frink.dev',
  route: 'a1'.repeat(32),
  key: `${'K'.repeat(42)}A`,
  machine: 'Studio Mac',
  code: `${'a'.repeat(41)}-_`,
};

describe('mobilePairingLink', () => {
  it('round-trips through the reader the phone uses', () => {
    const link = mobilePairingLink(pairing);
    expect(link.startsWith(`${MOBILE_PAIRING_LINK}?`)).toBe(true);
    expect(mobilePairingSchema.parse(mobilePairingFields(link))).toEqual(pairing);
  });

  it('carries the relay, route, pinned key, machine and code, with the version last', () => {
    expect(mobilePairingLink(pairing)).toBe(
      `frink-mobile://pair?relay=https%3A%2F%2Frelay.frink.dev&route=${pairing.route}&key=${pairing.key}&machine=Studio+Mac&code=${pairing.code}&v=3`,
    );
  });

  it('refuses a link without a pinned desktop key or with a plaintext relay', () => {
    const { key: _key, ...unpinned } = pairing;
    expect(mobilePairingSchema.safeParse(unpinned).success).toBe(false);
    expect(
      mobilePairingSchema.safeParse({ ...pairing, relay: 'http://relay.frink.dev' }).success,
    ).toBe(false);
    expect(
      mobilePairingSchema.safeParse({ ...pairing, relay: 'https://relay.frink.dev/x' }).success,
    ).toBe(false);
  });

  it('reads an explicit default port as the same relay origin', () => {
    const parsed = mobilePairingSchema.parse({ ...pairing, relay: 'https://relay.frink.dev:443/' });
    expect(parsed.relay).toBe('https://relay.frink.dev');
  });
});
