import { describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/relay/client', () => ({ relayRequest: vi.fn(), closeMobileRelay: vi.fn() }));
import { ApiError } from '../../lib/api';
import { pairingFailure, readPairing, UPDATE_FRINK } from './pairing';

const code = (version = 3) =>
  JSON.stringify({
    version,
    relay: 'https://relay.example.test',
    route: 'c'.repeat(64),
    key: 'a'.repeat(43),
    machine: 'Studio Mac',
    code: 'a'.repeat(43),
  });

describe('readPairing', () => {
  it('reads the Mac a valid code points at', () => {
    expect(readPairing(`  ${code()}\n`)).toEqual({
      ok: true,
      text: code(),
      host: 'relay.example.test',
      name: 'Studio Mac',
      route: 'c'.repeat(64),
      key: 'a'.repeat(43),
    });
  });

  it('stays quiet while the field is empty', () => {
    expect(readPairing('  ')).toEqual({ ok: false, problem: null });
  });

  it('asks for an update when the code comes from another Frink version', () => {
    expect(readPairing(code(1))).toEqual({ ok: false, problem: UPDATE_FRINK });
    expect(readPairing(`frink-mobile://pair?url=https%3A%2F%2Fmac.test%2F&code=x&v=2`)).toEqual({
      ok: false,
      problem: UPDATE_FRINK,
    });
  });

  it('explains a partial or unrelated paste', () => {
    for (const text of [
      '{"version":2',
      'hello',
      JSON.stringify({ version: 3, relay: 'http://x.test/', code: 'a' }),
      `frink-mobile://pair?url=https%3A%2F%2Fmac.test%2F&code=${'a'.repeat(20)}`,
      `frink-mobile://pair?url=https%3A%2F%2Fmac.test%2F&code=${'a'.repeat(43)}&v=`,
      `frink-mobile://pair?url=https%3A%2F%2Fmac.test%2F&code=${'a'.repeat(43)}&v`,
    ])
      expect(readPairing(text)).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/full pairing code/),
      });
  });
});

describe('pairingFailure', () => {
  it('names the cause and the fix in plain words', () => {
    expect(pairingFailure(new ApiError('offline', 0))).toMatch(
      /Can’t reach your Mac. Keep Frink open/,
    );
    expect(pairingFailure(new ApiError('expired', 401))).toMatch(/expired or was already used/);
    expect(pairingFailure(new ApiError('slow down', 429))).toMatch(/Too many tries/);
    expect(pairingFailure(new ApiError('boom', 500))).toMatch(/couldn’t finish connecting/);
  });

  it('treats a reply this app cannot read as a version mismatch', () => {
    expect(pairingFailure(new Error('Update Frink on your computer and phone.'))).toBe(
      UPDATE_FRINK,
    );
  });
});
