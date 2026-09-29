import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/apns';

type Worker = typeof import('../src/index').default;

const TOKEN = 'ab'.repeat(32);
const JWT_WINDOW_MS = 45 * 60 * 1000;
const T0 = JWT_WINDOW_MS * 650_000 + 10_000;
const update = { token: TOKEN, event: 'update', running: 3, needsYou: 1, urgent: true };

let keys: CryptoKeyPair;
let env: Env;
let apns: ReturnType<typeof vi.fn<typeof fetch>>;
let worker: Worker;

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const decodePart = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));

function expectNoTokenLogged(warn: ReturnType<typeof vi.spyOn>) {
  for (const args of warn.mock.calls) expect(args.join(' ')).not.toContain(TOKEN);
}

async function loadWorker(): Promise<Worker> {
  vi.resetModules();
  return (await import('../src/index')).default;
}

type SendInit = { path?: string; method?: string; length?: number | null; raw?: string };

function send(body: unknown, init: SendInit = {}) {
  const text = init.raw ?? JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.length !== null) headers.set('content-length', String(init.length ?? text.length));
  const request = new Request(`https://forwarder.test${init.path ?? '/live-activity'}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.method && init.method !== 'POST' ? undefined : text,
  });
  return worker.fetch(request, env);
}

function apnsCall() {
  const [url, init] = apns.mock.calls.at(-1)!;
  return {
    url,
    headers: init!.headers as Record<string, string>,
    body: JSON.parse(init!.body as string),
  };
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', keys.privateKey)) as ArrayBuffer,
  );
  // Pasted secrets often arrive with literal "\n" in place of line breaks.
  const body = btoa(String.fromCharCode(...der)).replace(/.{64}/g, '$&\\n');
  env = {
    APNS_KEY_ID: 'KEY123',
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${body}\\n-----END PRIVATE KEY-----`,
  };
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  apns = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', apns);
  worker = await loadWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('APNs request', () => {
  it('sends an update with a valid ES256 provider token', async () => {
    const response = await send(update);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const { url, headers, body } = apnsCall();
    const ts = Math.floor(T0 / 1000);
    expect(url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    expect(headers).toMatchObject({
      'apns-push-type': 'liveactivity',
      'apns-topic': 'dev.frink.mobile.push-type.liveactivity',
      'apns-priority': '10',
    });
    expect(body).toEqual({
      aps: {
        timestamp: ts,
        event: 'update',
        'content-state': { name: 'FrinkStatus', props: '{"running":3,"needsYou":1}' },
        'stale-date': ts + 1800,
      },
    });

    const [header, payload, signature] = headers.authorization.replace('bearer ', '').split('.');
    expect(decodePart(header)).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(decodePart(payload)).toEqual({
      iss: 'R3CSC7X7DA',
      iat: Math.floor(T0 / JWT_WINDOW_MS) * 2700,
    });
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
    expect(
      await crypto.subtle.verify(algorithm, keys.publicKey, fromBase64Url(signature), signed),
    ).toBe(true);
  });

  it('sends a routine update at low priority', async () => {
    await send({ ...update, urgent: false });
    expect(apnsCall().headers['apns-priority']).toBe('5');
  });

  it('ends the card at once with zero counts', async () => {
    await send({ ...update, event: 'end', urgent: false });
    const ts = Math.floor(T0 / 1000);
    expect(apnsCall().headers['apns-priority']).toBe('10');
    expect(apnsCall().body).toEqual({
      aps: {
        timestamp: ts,
        event: 'end',
        'content-state': { name: 'FrinkStatus', props: '{"running":0,"needsYou":0}' },
        'dismissal-date': ts,
      },
    });
  });

  it('gives every isolate the byte-identical token within a window, and a new one after', async () => {
    const jwt = () => apnsCall().headers.authorization;
    await send(update);
    const first = jwt();

    worker = await loadWorker();
    vi.setSystemTime(T0 + 30 * 60 * 1000);
    await send(update);
    expect(jwt()).toBe(first);

    worker = await loadWorker();
    vi.setSystemTime(T0 + JWT_WINDOW_MS);
    await send(update);
    expect(jwt()).not.toBe(first);
  });
});

describe('validation', () => {
  it.each([
    ['an extra field', { ...update, title: 'Fix the build' }, {}],
    ['an uppercase token', { ...update, token: 'AB'.repeat(32) }, {}],
    ['a short token', { ...update, token: 'ab'.repeat(31) }, {}],
    ['a count over 999', { ...update, running: 1000 }, {}],
    ['a body over 512 bytes', update, { length: 513 }],
    ['an empty body length', update, { length: 0 }],
    ['a missing body length', update, { length: null }],
    ['a body that is not JSON', undefined, { raw: '{' }],
  ])('rejects %s', async (_, body, init) => {
    expect((await send(body, init)).status).toBe(400);
    expect(apns).not.toHaveBeenCalled();
  });

  it('allows only POST on /live-activity', async () => {
    const get = await send(update, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await send(update, { path: '/' })).status).toBe(404);
    expect(apns).not.toHaveBeenCalled();
  });
});

describe('APNs status mapping', () => {
  const gone = { gone: true };
  const retry = { retryAfter: 60 };

  it.each([
    [410, 'Unregistered', 410, gone],
    [400, 'BadDeviceToken', 410, gone],
    [410, 'ExpiredToken', 410, gone],
    [429, 'TooManyRequests', 429, retry],
    [403, 'InvalidProviderToken', 502, null],
    [400, 'TopicDisallowed', 502, null],
  ])('maps APNs %i %s to %i', async (status, reason, expected, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apns.mockResolvedValueOnce(Response.json({ reason }, { status }));
    const response = await send(update);
    expect(response.status).toBe(expected);
    expect(body ? await response.json() : await response.text()).toEqual(body ?? '');
    expectNoTokenLogged(warn);
  });

  it('answers 502 when APNs cannot be reached, without logging the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apns.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await send(update)).status).toBe(502);
    expect(warn).toHaveBeenCalled();
    expectNoTokenLogged(warn);
  });
});

describe('rate limits', () => {
  it('allows one push per token every 5 seconds', async () => {
    expect((await send(update)).status).toBe(200);
    const limited = await send(update);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ retryAfter: 5 });
    vi.setSystemTime(T0 + 5_000);
    expect((await send(update)).status).toBe(200);
  });

  it('lets an end through right after an update', async () => {
    expect((await send(update)).status).toBe(200);
    vi.setSystemTime(T0 + 1_000);
    expect((await send({ ...update, event: 'end' })).status).toBe(200);
    expect(apns).toHaveBeenCalledTimes(2);
  });

  it('allows 60 pushes per token per hour', async () => {
    for (let i = 0; i < 60; i++) {
      vi.setSystemTime(T0 + i * 5_000);
      expect((await send(update)).status).toBe(200);
    }
    vi.setSystemTime(T0 + 60 * 5_000);
    expect((await send(update)).status).toBe(429);
    vi.setSystemTime(T0 + 3_600_000);
    expect((await send(update)).status).toBe(200);
  });

  it('caps an isolate at 300 pushes a minute across all tokens', async () => {
    const token = (i: number) => i.toString(16).padStart(64, '0');
    for (let i = 0; i < 300; i++)
      expect((await send({ ...update, token: token(i) })).status).toBe(200);
    expect((await send({ ...update, token: token(300) })).status).toBe(429);
    expect(apns).toHaveBeenCalledTimes(300);
  });
});
