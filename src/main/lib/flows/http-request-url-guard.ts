/**
 * SSRF mitigation for flow `http_request` dispatch (Railway).
 * Limits must match `src/shared/lib/http-request-limits.ts`.
 */

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

export const HTTP_REQUEST_MAX_URL_LENGTH = 2048;
export const HTTP_REQUEST_MAX_BODY_UTF8_BYTES = 1_000_000;
export const HTTP_REQUEST_MAX_HEADERS_JSON_BYTES = 8192;

/** Known cloud metadata / link-local style hostnames (defense in depth vs IP checks). */
const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'instance-data.ec2.internal',
  'localhost',
  'metadata.azure.internal',
  'metadata.google.internal',
]);

const IPV6_TWO_HEXTET_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
/** Five zero hextets, then `ffff` and IPv4 tail (dotted or two hextets) — true expanded IPv4-mapped form only. */
const EXPANDED_IPV4_MAPPED_TAIL = /^(?:0{1,4}:){5}ffff:(.+)$/i;
const TRAILING_DOT_REGEX = /\.$/;

/** DNS / resolver errors where retry may succeed (distinct from NXDOMAIN-style ENOTFOUND). */
const TRANSIENT_DNS_LOOKUP_CODES = new Set([
  'EAI_AGAIN',
  'SERVFAIL',
  'ESERVFAIL',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
]);

function getNodeErrnoCode(err: unknown): string {
  if (err === null || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (!isIPv4(ip)) return null;
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  const [a, b, c, d] = parts;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [a, b, c, d];
}

function isUnsafeIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * If IPv6 is IPv4-mapped (::ffff:… or expanded 0:…:0:ffff:…), return the embedded IPv4 dotted string.
 * True compressed IPv4-mapped form is `::ffff:x.x.x.x` — `::ffff:` must start at index 0.
 * Interior `::ffff:` (e.g. fe80::ffff:1.1.1.1) is not IPv4-mapped; do not use lastIndexOf alone.
 */
function embeddedIpv4FromMappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mappedPrefix = '::ffff:';
  let tail: string | null = null;
  const compressedIdx = lower.lastIndexOf(mappedPrefix);
  if (compressedIdx === 0) {
    tail = lower.slice(mappedPrefix.length);
  } else {
    const expanded = EXPANDED_IPV4_MAPPED_TAIL.exec(lower);
    if (expanded?.[1]) tail = expanded[1];
  }
  if (tail === null || tail.length === 0) return null;
  if (isIPv4(tail)) return tail;
  const twoHextet = IPV6_TWO_HEXTET_REGEX.exec(tail);
  if (twoHextet?.[1] && twoHextet[2]) {
    const hi = Number.parseInt(twoHextet[1], 16);
    const lo = Number.parseInt(twoHextet[2], 16);
    const word = ((hi & 0xffff) << 16) | (lo & 0xffff);
    const a = (word >>> 24) & 0xff;
    const b = (word >>> 16) & 0xff;
    const c = (word >>> 8) & 0xff;
    const d = word & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }
  return null;
}

/** True if IPv6 literal should be blocked (loopback, link-local, ULA, IPv4-mapped private). */
function isUnsafeIpv6(ip: string): boolean {
  if (!isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  const mappedV4 = embeddedIpv4FromMappedIpv6(lower);
  if (mappedV4 !== null) return isUnsafeIpv4(mappedV4);
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

function isUnsafeIpLiteral(ip: string): boolean {
  if (isIPv4(ip)) return isUnsafeIpv4(ip);
  if (isIPv6(ip)) return isUnsafeIpv6(ip);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(TRAILING_DOT_REGEX, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

type UrlGuardResult = { ok: true; url: URL } | { ok: false; message: string };

/**
 * Reject private/reserved targets and overlong URLs. For hostnames, resolves DNS and checks all A/AAAA.
 *
 * **Known limitation (v1):** DNS rebind TOCTOU — `fetch()` re-resolves the hostname at connect time,
 * so a validated public IP could resolve to a private IP between validation and fetch. Mitigated by:
 * - Validating all A/AAAA records upfront
 * - Per-hop re-validation on redirects
 * - Rate limiting abuse
 * Full mitigation requires IP pinning + custom fetch agent (future enhancement).
 */
export async function assertHttpRequestUrlSafe(rawUrl: string): Promise<UrlGuardResult> {
  if (rawUrl.length > HTTP_REQUEST_MAX_URL_LENGTH) {
    return { ok: false, message: 'http_request url too long' };
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, message: 'http_request invalid url' };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, message: 'http_request url must not include credentials' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: 'http_request url must be http or https' };
  }

  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const hostLower = host.toLowerCase();
  if (isBlockedHostname(hostLower)) {
    return { ok: false, message: 'http_request url host is not allowed' };
  }

  if (isIPv4(host) || isIPv6(host)) {
    if (isUnsafeIpLiteral(host)) {
      return { ok: false, message: 'http_request url target is not allowed' };
    }
    return { ok: true, url: u };
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) {
      return { ok: false, message: 'http_request host could not be resolved' };
    }
    for (const r of results) {
      if (isUnsafeIpLiteral(r.address)) {
        return { ok: false, message: 'http_request url resolves to a disallowed address' };
      }
    }
  } catch (err: unknown) {
    if (TRANSIENT_DNS_LOOKUP_CODES.has(getNodeErrnoCode(err))) {
      return { ok: false, message: 'http_request dns temporarily unavailable' };
    }
    return { ok: false, message: 'http_request host could not be resolved' };
  }

  return { ok: true, url: u };
}
