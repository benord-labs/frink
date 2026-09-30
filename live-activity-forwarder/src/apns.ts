import { p256 } from '@noble/curves/nist.js';

export type Env = { APNS_KEY_ID: string; APNS_PRIVATE_KEY: string };
export type Push = {
  token: string;
  event: 'update' | 'end';
  running: number;
  needsYou: number;
  urgent: boolean;
};

const TEAM_ID = 'R3CSC7X7DA';
const TOPIC = 'dev.frink.mobile.push-type.liveactivity';
// APNs answers 429 TooManyProviderTokenUpdates when the provider token changes more than about
// every 20 minutes, and rejects one older than 60. Every isolate rounds `iat` down to the same
// 45-minute window and signs deterministically (RFC 6979), so all of them present one token.
const JWT_WINDOW_SECONDS = 45 * 60;
const STALE_AFTER_SECONDS = 30 * 60;

const encoder = new TextEncoder();
let signingScalar: Promise<Uint8Array> | undefined;
let providerToken: { iat: number; jwt: string } | undefined;

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64Decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

/** The raw P-256 scalar from the .p8 PEM; tolerates a secret pasted with literal `\n`s. */
async function importScalar(pem: string): Promise<Uint8Array> {
  const der = base64Decode(pem.replace(/-----[^-]+-----|\\n|\s/g, ''));
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const key = await crypto.subtle.importKey('pkcs8', der, algorithm, true, ['sign']);
  const { d } = (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
  if (!d) throw new Error('APNS_PRIVATE_KEY is not a P-256 private key');
  return base64Decode(d);
}

async function jwtFor(env: Env, nowSeconds: number): Promise<string> {
  const iat = Math.floor(nowSeconds / JWT_WINDOW_SECONDS) * JWT_WINDOW_SECONDS;
  if (providerToken?.iat === iat) return providerToken.jwt;
  const part = (value: object) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const input = `${part({ alg: 'ES256', kid: env.APNS_KEY_ID })}.${part({ iss: TEAM_ID, iat })}`;
  signingScalar ??= importScalar(env.APNS_PRIVATE_KEY);
  const signature = p256.sign(encoder.encode(input), await signingScalar);
  providerToken = { iat, jwt: `${input}.${base64UrlEncode(signature)}` };
  return providerToken.jwt;
}

/** Sends one counts-only Live Activity push. No alert: the card never sounds or wakes the screen. */
export async function sendToApns(env: Env, push: Push, now = Date.now()): Promise<Response> {
  const timestamp = Math.floor(now / 1000);
  const ended = push.event === 'end';
  const counts = ended
    ? { running: 0, needsYou: 0 }
    : { running: push.running, needsYou: push.needsYou };
  const aps = {
    timestamp,
    event: push.event,
    'content-state': { name: 'FrinkStatus', props: JSON.stringify(counts) },
    ...(ended
      ? { 'dismissal-date': timestamp }
      : { 'stale-date': timestamp + STALE_AFTER_SECONDS }),
  };
  return fetch(`https://api.push.apple.com/3/device/${push.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${await jwtFor(env, timestamp)}`,
      'apns-push-type': 'liveactivity',
      'apns-topic': TOPIC,
      'apns-priority': push.urgent || ended ? '10' : '5',
    },
    body: JSON.stringify({ aps }),
  });
}
