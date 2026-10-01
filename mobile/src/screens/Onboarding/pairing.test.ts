import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { pairingFailure, readPairing, UPDATE_FRINK } from './pairing';

const code = (version = 2) =>
  JSON.stringify({ version, url: 'https://studio-mac.tail1234.ts.net/', code: 'a'.repeat(43) });

describe('readPairing', () => {
  it('reads the Mac a valid code points at', () => {
    expect(readPairing(`  ${code()}\n`)).toEqual({
      ok: true,
      text: code(),
      host: 'studio-mac.tail1234.ts.net',
      name: 'studio-mac',
    });
  });

  it('stays quiet while the field is empty', () => {
    expect(readPairing('  ')).toEqual({ ok: false, problem: null });
  });

  it('asks for an update when the code comes from another Frink version', () => {
    expect(readPairing(code(1))).toEqual({ ok: false, problem: UPDATE_FRINK });
    expect(readPairing(`frink-mobile://pair?url=https%3A%2F%2Fmac.test%2F&code=x&v=3`)).toEqual({
      ok: false,
      problem: UPDATE_FRINK,
    });
  });

  it('explains a partial or unrelated paste', () => {
    for (const text of [
      '{"version":2',
      'hello',
      JSON.stringify({ version: 2, url: 'http://x.test/', code: 'a' }),
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
      /Can’t reach your Mac. Check Tailscale/,
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
