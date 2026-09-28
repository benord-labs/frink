import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobilePairingStore } from './pairing-store';
import { createMobileApp, startMobileServer, stopMobileServer } from './server';

let directory: string;
let store: MobilePairingStore;
let token: string;
let deviceId: string;
let server: Server | undefined;
const execute = vi.fn(async () => ({ queue: [] }));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-mobile-server-'));
  store = new MobilePairingStore(join(directory, 'mobile.json'));
  await store.initialize();
  await store.enable();
  const { pairing } = await store.pair('https://computer.tailnet.ts.net:8443');
  ({ token, deviceId } = await store.redeem(pairing.code, 'Phone'));
  execute.mockReset();
  execute.mockResolvedValue({ queue: [] });
});
afterEach(async () => {
  if (server) {
    await stopMobileServer(server);
    server = undefined;
  }
  await rm(directory, { recursive: true, force: true });
});

function request(
  body: unknown,
  authorization: string | null = token,
  extraHeaders: Record<string, string> = {},
) {
  return createMobileApp(store, execute).request('/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe('mobile HTTP boundary', () => {
  it('requires bearer credentials and immediately honors device revocation', async () => {
    expect((await request({ type: 'overview' }, null)).status).toBe(401);
    expect((await request({ type: 'overview' }, 'wrong')).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    const response = await request({ type: 'overview' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { queue: [] } });
    expect(execute).toHaveBeenCalledWith({ type: 'overview' });
    await store.revoke(deviceId);
    expect((await request({ type: 'overview' })).status).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns authentication errors as JSON with no caching or browser CORS access', async () => {
    for (const authorization of [null, 'wrong', 'invalid token']) {
      const denied = await request({ type: 'overview' }, authorization);
      expect(await denied.json()).toHaveProperty('error');
      expect(denied.headers.get('cache-control')).toBe('no-store');
      expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
      expect(denied.headers.get('www-authenticate')).toContain('Bearer');
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(
      (await request({ type: 'overview' }, token, { Origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await request({ type: 'overview' }, token, { Origin: 'null' })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows pairing once and reports protocol version with the issued token', async () => {
    const { pairing } = await store.pair('https://computer.tailnet.ts.net:8443');
    const app = createMobileApp(store, execute);
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code, name: 'Second iPhone' }),
    };
    const response = await app.request('/pair', init);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      apiVersion: 1,
      machineName: expect.any(String),
      deviceId: expect.any(String),
      token: expect.any(String),
    });
    expect(store.authenticate(result.token)).toBe(true);
    expect((await app.request('/pair', init)).status).toBe(401);
  });

  it('rejects malformed JSON, unknown commands, oversize bodies and non-POST requests', async () => {
    const app = createMobileApp(store, execute);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    expect((await app.request('/api', { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await request({ type: 'deleteEverything' })).status).toBe(400);
    expect((await request({ type: 'overview', text: 'x'.repeat(128 * 1024) })).status).toBe(413);
    expect((await app.request('/api')).status).toBe(405);
    expect((await app.request('/api', { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await app.request('/settings', { method: 'POST', headers, body: '{}' })).status).toBe(
      404,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves domain conflicts while masking unexpected errors and stacks', async () => {
    execute.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'This question was already answered.' }),
    );
    const conflict = await request({ type: 'overview' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'This question was already answered.' });
    execute.mockRejectedValueOnce(new Error('/private/path secret implementation details'));
    const failure = await request({ type: 'overview' });
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toMatch(/private|secret|stack/);
  });

  it.each(['application/jsonp', 'application/json-seq', 'application/jsonbad'])(
    'rejects unsupported JSON-like media type %s before execution',
    async (contentType) => {
      const response = await request({ type: 'overview' }, token, {
        'Content-Type': contentType,
      });
      expect(response.status).toBe(415);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    ' Application/JSON ; charset=UTF-8 ',
  ])('accepts JSON media type %s with optional parameters', async (contentType) => {
    const response = await request({ type: 'overview' }, token, {
      'Content-Type': contentType,
    });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ type: 'overview' });
  });

  it('classifies invalid JSON only at the request body boundary', async () => {
    const app = createMobileApp(store, execute);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    for (const path of ['/pair', '/api']) {
      const response = await app.request(path, { method: 'POST', headers, body: '{' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid JSON request body.' });
    }
    expect(execute).not.toHaveBeenCalled();

    execute.mockRejectedValueOnce(new SyntaxError('/private/path internal JSON failure'));
    const failure = await request({ type: 'overview' });
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({
      error: 'Frink could not complete this request. Try again from the desktop.',
    });
  });

  it('rejects an authorized request revoked while its body is still arriving', async () => {
    const encoder = new TextEncoder();
    let finishBody: (() => void) | undefined;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":'));
        finishBody = () => {
          controller.enqueue(encoder.encode('"overview"}'));
          controller.close();
        };
      },
    });
    const pending = createMobileApp(store, execute).request('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      duplex: 'half',
    } as RequestInit);
    await store.revoke(deviceId);
    finishBody?.();
    expect((await pending).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('binds only to IPv4 loopback and closes the listener on shutdown', async () => {
    server = await startMobileServer(store, execute, 0);
    const address = server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'overview' }),
    });
    expect(response.status).toBe(200);
    await stopMobileServer(server);
    expect(server.listening).toBe(false);
    server = undefined;
  });
});

describe('mobile attachment uploads', () => {
  const upload = vi.fn(async () => ({ id: 'att-1', kind: 'image', name: 'photo.png', size: 4 }));

  function send(
    body: BodyInit,
    headers: Record<string, string> = {},
    authorization: string | null = token,
  ) {
    return createMobileApp(store, execute, upload).request('/api/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-Frink-Chat': 'chat-1',
        'X-Frink-Sub-Chat': 'sub-1',
        'X-Frink-Filename': encodeURIComponent('my photo.png'),
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        ...headers,
      },
      body,
    });
  }

  beforeEach(() => upload.mockClear());

  it('accepts a raw body and hands the bytes and decoded name to the uploader', async () => {
    const response = await send(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { id: 'att-1', kind: 'image', name: 'photo.png', size: 4 },
    });
    expect(upload).toHaveBeenCalledWith({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      name: 'my photo.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
  });

  it('requires the same pairing as the JSON API and still refuses browsers', async () => {
    expect((await send(new Uint8Array([1]), {}, null)).status).toBe(401);
    expect((await send(new Uint8Array([1]), {}, 'wrong')).status).toBe(401);
    expect((await send(new Uint8Array([1]), { Origin: 'https://evil.example' })).status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  });

  it('allows attachment-sized bodies here while the JSON API keeps its small limit', async () => {
    const big = new Uint8Array(512 * 1024);
    expect((await send(big)).status).toBe(200);
    expect((await request({ type: 'overview', padding: 'x'.repeat(200 * 1024) })).status).toBe(413);
  });

  it('rejects a missing chat header instead of storing an orphan file', async () => {
    expect((await send(new Uint8Array([1]), { 'X-Frink-Chat': '' })).status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });
});
