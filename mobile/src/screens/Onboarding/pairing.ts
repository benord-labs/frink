import { MOBILE_API_VERSION } from '../../../../src/shared/types/remote/mobile';
import { ApiError, parsePairing } from '../../lib/api';

export const UPDATE_FRINK = 'Update Frink on your Mac, then make a new code.';
const NOT_A_CODE =
  'This isn’t a full pairing code. Copy it again from Frink on your Mac → Settings → Mobile.';

export type PairingRead =
  | { ok: true; text: string; host: string; name: string }
  | { ok: false; problem: string | null };

/** A code from another Frink version still parses as JSON, so it can be told apart from a bad paste. */
function otherVersion(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text.trim());
    const version = (value as { version?: unknown } | null)?.version;
    return typeof version === 'number' && version !== MOBILE_API_VERSION;
  } catch {
    return false;
  }
}

/** Reads a scanned or pasted code into the Mac it points at, or says plainly what is wrong. */
export function readPairing(text: string): PairingRead {
  if (!text.trim()) return { ok: false, problem: null };
  try {
    const host = new URL(parsePairing(text).url).hostname;
    return { ok: true, text: text.trim(), host, name: host.split('.')[0] || host };
  } catch {
    return { ok: false, problem: otherVersion(text) ? UPDATE_FRINK : NOT_A_CODE };
  }
}

/**
 * What went wrong while pairing, for someone who has never heard of HTTP. Any failure after the
 * Mac answered that isn't an HTTP error means the reply wasn't one this app understands.
 */
export function pairingFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return UPDATE_FRINK;
  if (error.status === 0)
    return 'Can’t reach your Mac. Check Tailscale is on for both devices, then try again.';
  if (error.status === 401)
    return 'This code has expired or was already used. Make a new one in Frink on your Mac → Settings → Mobile.';
  if (error.status === 429)
    return 'Too many tries with this code. Make a new one in Frink on your Mac → Settings → Mobile.';
  return 'Frink on your Mac couldn’t finish connecting. Make a new code and try again.';
}
