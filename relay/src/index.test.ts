import { createHash, randomBytes } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from './index.js';

// Named off the global fetch: @types/node does not publish BodyInit/HeadersInit as globals.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

type InboundFrame = {
  t: string;
  provider: string;
  headers: Record<string, string>;
  bodyB64: string;
  receivedAt: string;
};

let relay: Relay;
let baseUrl: string;
const clients: Socket[] = [];

function tokenFor(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function newKey(): string {
  return randomBytes(32).toString('hex');
}

async function connect(extraHeaders?: Record<string, string>): Promise<Socket> {
  const socket = connectClient(baseUrl, { transports: ['websocket'], extraHeaders });
  clients.push(socket);
  await new Promise<void>((resolve) => {
    socket.on('connect', () => resolve());
  });
  return socket;
}

function collect(socket: Socket): InboundFrame[] {
  const seen: InboundFrame[] = [];
  socket.on('inbound', (frame: InboundFrame) => {
    seen.push(frame);
  });
  return seen;
}

function joined(key: string): void {
  expect(relay.io.sockets.adapter.rooms.has(tokenFor(key))).toBe(true);
}

async function subscribe(key: string): Promise<InboundFrame[]> {
  const socket = await connect();
  const seen = collect(socket);
  socket.emit('subscribe', { key });
  await vi.waitFor(() => {
    joined(key);
  });
  return seen;
}

function post(token: string, body: FetchInit['body'], headers: FetchInit['headers'] = {}) {
  return fetch(`${baseUrl}/api/triggers/github/${token}`, { method: 'POST', body, headers });
}

function postVia(agent: Agent, token: string, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}/api/triggers/github/${token}`,
      { method: 'POST', agent, timeout: 2000 },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('timeout', () => request.destroy(new Error('the connection was never released')));
    request.on('error', reject);
    request.end(body);
  });
}

function decode(frame: InboundFrame): string {
  return Buffer.from(frame.bodyB64, 'base64').toString('utf8');
}

// Nineteen subscribes from one claimed address then two from another: if both were counted as one
// caller the 21st is refused, so its room is absent and a delivery addressed to it reaches nobody.
async function sharesOneBudget(first: string, second: string): Promise<void> {
  const spent = Array.from({ length: 19 }, () => newKey());
  const spender = await connect({ 'x-forwarded-for': first });
  for (const key of spent) spender.emit('subscribe', { key });
  await vi.waitFor(() => {
    joined(spent[18]);
  });

  const allowed = newKey();
  const refused = newKey();
  const latecomer = await connect({ 'x-forwarded-for': second });
  const seen = collect(latecomer);
  latecomer.emit('subscribe', { key: allowed });
  latecomer.emit('subscribe', { key: refused });
  await vi.waitFor(() => {
    joined(allowed);
  });

  await post(tokenFor(refused), '{"refused":true}');
  await post(tokenFor(allowed), '{"kept":true}');

  await vi.waitFor(() => {
    expect(seen).toHaveLength(1);
  });
  expect(decode(seen[0])).toBe('{"kept":true}');
  expect(relay.io.sockets.adapter.rooms.has(tokenFor(refused))).toBe(false);
}

// Twenty subscribes from one claimed address, then one from another: only a separate budget lets it join.
async function keepSeparateBudgets(first: string, second: string): Promise<void> {
  const spent = Array.from({ length: 20 }, () => newKey());
  const spender = await connect({ 'x-forwarded-for': first });
  for (const key of spent) spender.emit('subscribe', { key });
  await vi.waitFor(() => {
    joined(spent[19]);
  });

  const fresh = newKey();
  const elsewhere = await connect({ 'x-forwarded-for': second });
  elsewhere.emit('subscribe', { key: fresh });
  await vi.waitFor(() => {
    joined(fresh);
  });
}

async function startRelay(options?: Parameters<typeof createRelay>[0]): Promise<void> {
  relay = createRelay(options);
  await new Promise<void>((resolve) => {
    relay.httpServer.listen(0, resolve);
  });
  const address = relay.httpServer.address();
  if (!(address instanceof Object)) throw new Error('relay did not bind a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

// Options and RELAY_TRUSTED_PROXY_HOPS are read when the relay is built, so a test that changes
// either replaces the one the default beforeEach started.
async function restartRelay(options?: Parameters<typeof createRelay>[0]): Promise<void> {
  await relay.close();
  await startRelay(options);
}

beforeEach(async () => {
  await startRelay();
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await relay.close();
  vi.unstubAllEnvs();
});

describe('delivery forwarding', () => {
  it('reaches the holder of the matching key and nobody else', async () => {
    const key = newKey();
    const holder = await subscribe(key);
    const impostor = await subscribe(newKey());

    const response = await post(tokenFor(key), '{"hello":"world"}');

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(holder[0].t).toBe(tokenFor(key));
    expect(holder[0].provider).toBe('github');
    expect(decode(holder[0])).toBe('{"hello":"world"}');
    expect(impostor).toHaveLength(0);
  });

  it('keeps the forwarded bytes identical to the bytes received', async () => {
    const key = newKey();
    const holder = await subscribe(key);
    const body = '{"note":"café"}\n';

    await post(tokenFor(key), body);

    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(Buffer.from(holder[0].bodyB64, 'base64').equals(Buffer.from(body, 'utf8'))).toBe(true);
  });

  it('forwards the vendor headers verbatim', async () => {
    const key = newKey();
    const holder = await subscribe(key);

    await post(tokenFor(key), '{}', {
      'x-hub-signature-256': 'sha256=abc',
      'x-github-event': 'push',
    });

    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(holder[0].headers['x-hub-signature-256']).toBe('sha256=abc');
    expect(holder[0].headers['x-github-event']).toBe('push');
  });
});

describe('fixed response', () => {
  it('answers identically with and without a subscriber', async () => {
    const watched = newKey();
    await subscribe(watched);

    const withHolder = await post(tokenFor(watched), '{}');
    const withoutHolder = await post(tokenFor(newKey()), '{}');

    expect(withHolder.status).toBe(202);
    expect(withoutHolder.status).toBe(202);
    expect(await withHolder.text()).toBe(await withoutHolder.text());
  });

  it('answers the same way for an address that cannot exist, and forwards nothing', async () => {
    const key = newKey();
    const holder = await subscribe(key);

    const response = await post('not-a-token', '{"rejected":true}');

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"status":"accepted"}');
    await post(tokenFor(key), '{"kept":true}');
    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(decode(holder[0])).toBe('{"kept":true}');
  });

  it('serves the health check', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
  });
});

describe('body cap', () => {
  it('refuses an over-sized body and forwards nothing', async () => {
    const key = newKey();
    const holder = await subscribe(key);

    const response = await post(tokenFor(key), new Uint8Array(2 * 1024 * 1024));

    expect(response.status).toBe(413);
    await post(tokenFor(key), '{"kept":true}');
    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(decode(holder[0])).toBe('{"kept":true}');
  });

  it('leaves the sender able to deliver again on the same connection', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const token = tokenFor(newKey());

    const refused = await postVia(agent, token, Buffer.alloc(2 * 1024 * 1024));
    const accepted = await postVia(agent, token, Buffer.from('{}'));
    agent.destroy();

    expect(refused).toBe(413);
    expect(accepted).toBe(202);
  });

  it('survives a sender that hangs up mid-body and forwards nothing for it', async () => {
    const key = newKey();
    const holder = await subscribe(key);
    let escaped = 0;
    const onRejection = () => {
      escaped += 1;
    };
    process.on('unhandledRejection', onRejection);
    const port = Number(new URL(baseUrl).port);

    await new Promise<void>((resolve) => {
      const socket = tcpConnect(port, '127.0.0.1', () => {
        socket.write(
          `POST /api/triggers/github/${tokenFor(key)} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4096\r\n\r\n{"partial":`,
          () => socket.destroy(),
        );
      });
      socket.on('close', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await post(tokenFor(key), '{"kept":true}');
    process.off('unhandledRejection', onRejection);

    expect(escaped).toBe(0);
    expect(after.status).toBe(202);
    await vi.waitFor(() => {
      expect(holder).toHaveLength(1);
    });
    expect(decode(holder[0])).toBe('{"kept":true}');
  });
});

describe('subscribe', () => {
  it('ignores a frame whose key is not 32 bytes of hex', async () => {
    const junk = 'not-a-key';
    const good = newKey();
    const socket = await connect();

    socket.emit('subscribe', { key: junk });
    socket.emit('subscribe', { key: good });

    await vi.waitFor(() => {
      joined(good);
    });
    expect(relay.io.sockets.adapter.rooms.has(tokenFor(junk))).toBe(false);
  });
});

describe('rate limits', () => {
  it('counts deliveries per address, not per sender', async () => {
    const busy = tokenFor(newKey());
    const quiet = tokenFor(newKey());

    for (let sent = 0; sent < 60; sent += 1) {
      expect((await post(busy, '{}')).status).toBe(202);
    }

    expect((await post(busy, '{}')).status).toBe(429);
    expect((await post(quiet, '{}')).status).toBe(202);
  });

  it('caps subscribe attempts per address of origin', async () => {
    const spent = Array.from({ length: 19 }, () => newKey());
    const spender = await connect();
    for (const key of spent) spender.emit('subscribe', { key });
    await vi.waitFor(() => {
      joined(spent[18]);
    });

    const allowed = newKey();
    const refused = newKey();
    const latecomer = await connect();
    const seen = collect(latecomer);
    latecomer.emit('subscribe', { key: allowed });
    latecomer.emit('subscribe', { key: refused });
    await vi.waitFor(() => {
      joined(allowed);
    });

    await post(tokenFor(refused), '{"refused":true}');
    await post(tokenFor(allowed), '{"kept":true}');

    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(decode(seen[0])).toBe('{"kept":true}');
  });

  it('counts an IPv6 caller by its prefix, not by the address it minted itself', async () => {
    await sharesOneBudget('2001:db8::1', '2001:db8::2');

    const fresh = newKey();
    const elsewhere = await connect({ 'x-forwarded-for': '2001:db9::1' });
    elsewhere.emit('subscribe', { key: fresh });

    await vi.waitFor(() => {
      joined(fresh);
    });
  });

  it('tells forwarded senders apart when a proxy sits in front', async () => {
    await keepSeparateBudgets('203.0.113.7', '198.51.100.4');
  });

  it('keeps IPv4 peers apart when a dual-stack listener reports them as IPv4-mapped IPv6', async () => {
    await keepSeparateBudgets('::ffff:203.0.113.7', '::ffff:198.51.100.4');
  });

  it('stops one connection at its own frame cap while its address still has budget', async () => {
    await restartRelay({ subscribesPerSocket: 3 });
    const affordable = Array.from({ length: 3 }, () => newKey());
    const refused = newKey();
    const spender = await connect();
    for (const key of affordable) spender.emit('subscribe', { key });
    // Enough over-cap frames to exhaust the per-address budget if they were counted against it.
    for (let sent = 0; sent < 20; sent += 1) spender.emit('subscribe', { key: refused });
    await vi.waitFor(() => {
      joined(affordable[2]);
    });

    const spare = newKey();
    const latecomer = await connect();
    latecomer.emit('subscribe', { key: spare });
    await vi.waitFor(() => {
      joined(spare);
    });

    for (const key of affordable) joined(key);
    expect(relay.io.sockets.adapter.rooms.has(tokenFor(refused))).toBe(false);
  });

  it('gives a connection its frames back when the window turns over', async () => {
    await restartRelay({ subscribesPerSocket: 1, windowMs: 200 });
    const spent = newKey();
    const refused = newKey();
    const spender = await connect();
    spender.emit('subscribe', { key: spent });
    spender.emit('subscribe', { key: refused });
    await vi.waitFor(() => {
      joined(spent);
    });
    expect(relay.io.sockets.adapter.rooms.has(tokenFor(refused))).toBe(false);

    const afterWindow = newKey();
    await new Promise((resolve) => setTimeout(resolve, 250));
    spender.emit('subscribe', { key: afterWindow });

    await vi.waitFor(() => {
      joined(afterWindow);
    });
  });
});

describe('trusted proxy hops', () => {
  it('counts two senders behind one proxy as one, whatever they claim in front of it', async () => {
    const proxy = '203.0.113.7';

    await sharesOneBudget(`10.9.9.1, ${proxy}`, `198.51.100.4, ${proxy}`);
  });

  it('ignores the header entirely when nothing is in front of it', async () => {
    vi.stubEnv('RELAY_TRUSTED_PROXY_HOPS', '0');
    await restartRelay();

    await sharesOneBudget('203.0.113.7', '198.51.100.4');
  });

  it('refuses to start when the hop count is not a number', async () => {
    vi.stubEnv('RELAY_TRUSTED_PROXY_HOPS', 'one');

    await expect(restartRelay()).rejects.toThrow(
      'RELAY_TRUSTED_PROXY_HOPS must be a non-negative integer',
    );
  });

  it('reads the sender from as many hops as the environment says are ours', async () => {
    vi.stubEnv('RELAY_TRUSTED_PROXY_HOPS', '2');
    await restartRelay();
    const inner = '10.0.0.1';
    const spent = Array.from({ length: 20 }, () => newKey());
    const busy = await connect({ 'x-forwarded-for': `203.0.113.7, ${inner}` });
    for (const key of spent) busy.emit('subscribe', { key });
    await vi.waitFor(() => {
      joined(spent[19]);
    });

    const fresh = newKey();
    const elsewhere = await connect({ 'x-forwarded-for': `198.51.100.4, ${inner}` });
    elsewhere.emit('subscribe', { key: fresh });

    await vi.waitFor(() => {
      joined(fresh);
    });
  });
});
