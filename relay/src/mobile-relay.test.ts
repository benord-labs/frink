import { createHash } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay } from './index.js';

let relay: Relay | undefined;
const clients: Socket[] = [];
const key = 'a'.repeat(64);
const route = createHash('sha256').update(key).digest('hex');

async function start(options: Parameters<typeof createRelay>[0] = {}) {
  relay = createRelay(options);
  await new Promise<void>((resolve) => relay!.httpServer.listen(0, '127.0.0.1', resolve));
  const address = relay.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('No listening port');
  return `http://127.0.0.1:${address.port}/mobile`;
}

async function dial(url: string, auth: object, extraHeaders?: Record<string, string>) {
  const socket = connect(url, {
    auth,
    extraHeaders,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function event(socket: Socket, name: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(name, resolve));
}

afterEach(async () => {
  clients.splice(0).forEach((socket) => socket.disconnect());
  await relay?.close();
});

describe('mobile relay', () => {
  it('splices opaque frames in both directions with receipt acknowledgments', async () => {
    const url = await start();
    const desktop = await dial(url, { role: 'desktop', key });
    const joined = event(desktop, 'peer-connected');
    const phone = await dial(url, { role: 'phone', route });
    expect(await joined).toBe(phone.id);
    desktop.on('frame', (frame, ack) => {
      expect(frame).toEqual({ peerId: phone.id, data: Buffer.from('opaque-from-phone') });
      ack();
    });
    expect(await phone.timeout(500).emitWithAck('frame', Buffer.from('opaque-from-phone'))).toBe(
      true,
    );
    phone.on('frame', (frame, ack) => {
      expect(frame).toEqual(Buffer.from('opaque-from-desktop'));
      ack();
    });
    expect(
      await desktop.timeout(500).emitWithAck('frame', {
        peerId: phone.id,
        data: Buffer.from('opaque-from-desktop'),
      }),
    ).toBe(true);
  });

  it('refuses missing desktops and replaces a stale host on a new ownership proof', async () => {
    const url = await start();
    await expect(dial(url, { role: 'phone', route })).rejects.toThrow('unavailable');
    const desktop = await dial(url, { role: 'desktop', key });
    const phone = await dial(url, { role: 'phone', route });
    const hostGone = event(desktop, 'disconnect');
    const phoneGone = event(phone, 'disconnect');
    const replacement = await dial(url, { role: 'desktop', key });
    await Promise.all([hostGone, phoneGone]);
    expect((await dial(url, { role: 'phone', route })).connected).toBe(true);
    expect(replacement.connected).toBe(true);
  });

  it('does not let a route id claim the original desktop route', async () => {
    const url = await start();
    const impostor = await dial(url, { role: 'desktop', key: route });
    const desktop = await dial(url, { role: 'desktop', key });
    const observed: unknown[] = [];
    impostor.on('peer-connected', (peer) => observed.push(peer));
    const connected = event(desktop, 'peer-connected');
    const phone = await dial(url, { role: 'phone', route });
    expect(await connected).toBe(phone.id);
    expect(observed).toEqual([]);
  });

  it('isolates routes even when a desktop knows another phone socket id', async () => {
    const url = await start();
    const desktop = await dial(url, { role: 'desktop', key });
    const second = await dial(url, { role: 'desktop', key: 'b'.repeat(64) });
    const phone = await dial(url, { role: 'phone', route });
    const dropped = event(second, 'disconnect');
    second.emit('frame', { peerId: phone.id, data: Buffer.from('forged') }, () => {});
    await dropped;
    expect(desktop.connected && phone.connected).toBe(true);
  });

  it('disconnects phones on host loss and reports phone loss to the desktop', async () => {
    const url = await start();
    const desktop = await dial(url, { role: 'desktop', key });
    const phone = await dial(url, { role: 'phone', route });
    const peerId = phone.id;
    const left = event(desktop, 'peer-disconnected');
    phone.disconnect();
    expect(await left).toBe(peerId);
    const nextPhone = await dial(url, { role: 'phone', route });
    const disconnected = event(nextPhone, 'disconnect');
    desktop.disconnect();
    await disconnected;
    await expect(dial(url, { role: 'phone', route })).rejects.toThrow('unavailable');
  });

  it('lets a desktop revoke one live peer immediately', async () => {
    const url = await start();
    const desktop = await dial(url, { role: 'desktop', key });
    const phone = await dial(url, { role: 'phone', route });
    const other = await dial(url, { role: 'phone', route });
    const disconnected = event(phone, 'disconnect');
    desktop.emit('disconnect-peer', phone.id);
    await disconnected;
    expect(other.connected).toBe(true);
  });

  it('bounds simultaneous phone admissions per route', async () => {
    const url = await start({ mobile: { phonesPerRoute: 1 } });
    await dial(url, { role: 'desktop', key });
    const results = await Promise.allSettled([
      dial(url, { role: 'phone', route }),
      dial(url, { role: 'phone', route }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it.each(['plaintext', { unexpected: true }, Buffer.alloc(256 * 1024 + 1)])(
    'disconnects senders of invalid or oversized frames (%#)',
    async (data) => {
      const url = await start();
      const desktop = await dial(url, { role: 'desktop', key });
      const phone = await dial(url, { role: 'phone', route });
      const forwarded: unknown[] = [];
      desktop.on('frame', (frame) => forwarded.push(frame));
      const disconnected = event(phone, 'disconnect');
      phone.emit('frame', data, () => {});
      await disconnected;
      expect(forwarded).toEqual([]);
    },
  );

  it.each([{ framesPerMinute: 1 }, { bytesPerMinute: 1 }])(
    'caps frame and byte traffic (%j)',
    async (mobile) => {
      const url = await start({ mobile });
      const desktop = await dial(url, { role: 'desktop', key });
      const phone = await dial(url, { role: 'phone', route });
      desktop.on('frame', (_frame, ack) => ack());
      await phone.timeout(500).emitWithAck('frame', Buffer.from('a'));
      const disconnected = event(phone, 'disconnect');
      phone.emit('frame', Buffer.from('b'), () => {});
      await disconnected;
    },
  );

  it('disconnects slow peers instead of retaining unbounded queued ciphertext', async () => {
    const url = await start({ mobile: { pendingFrames: 2 } });
    await dial(url, { role: 'desktop', key });
    const phone = await dial(url, { role: 'phone', route });
    const disconnected = event(phone, 'disconnect');
    for (let i = 0; i < 3; i++) phone.emit('frame', Buffer.from('opaque'), () => {});
    await disconnected;
  });

  it('expires a forwarded frame whose recipient never acknowledges it', async () => {
    const url = await start({ mobile: { ackTimeoutMs: 20 } });
    await dial(url, { role: 'desktop', key });
    const phone = await dial(url, { role: 'phone', route });
    const disconnected = event(phone, 'disconnect');
    phone.emit('frame', Buffer.from('opaque'), () => {});
    await disconnected;
  });

  it('rate limits reconnections using the trusted proxy hop, not attacker prefixes', async () => {
    const url = await start({ mobile: { attemptsPerMinute: 2 } });
    await dial(url, { role: 'desktop', key }, { 'x-forwarded-for': '1.1.1.1, 192.0.2.1' });
    await dial(url, { role: 'phone', route }, { 'x-forwarded-for': '2.2.2.2, 192.0.2.1' });
    await expect(
      dial(
        url,
        { role: 'phone', route },
        {
          'x-forwarded-for': '3.3.3.3, 192.0.2.1',
        },
      ),
    ).rejects.toThrow();
  });

  it.each([{ sockets: 2 }, { socketsPerIp: 2 }])(
    'bounds raw connections before a namespace is chosen (%j)',
    async (mobile) => {
      const url = (await start({ mobile })).replace('/mobile', '');
      await dial(url, {});
      const second = await dial(url, {});
      await expect(dial(url, {})).rejects.toThrow();
      second.disconnect();
      await vi.waitFor(() => expect(relay!.io.engine.clientsCount).toBe(1));
      expect((await dial(url, {})).connected).toBe(true);
    },
  );

  it('refuses browser origins', async () => {
    const url = await start();
    await expect(
      dial(
        url,
        { role: 'desktop', key },
        {
          Origin: 'https://example.com',
        },
      ),
    ).rejects.toThrow('unavailable');
  });

  it.each([{ sockets: 1 }, { socketsPerIp: 1 }])(
    'reserves capacity before asynchronous handshakes complete (%j)',
    async (mobile) => {
      const url = (await start({ mobile })).replace('/mobile', '');
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const generateId = relay!.io.engine.generateId.bind(relay!.io.engine);
      const generate = vi
        .spyOn(relay!.io.engine, 'generateId')
        .mockImplementation(async (request) => {
          await paused;
          return generateId(request);
        });
      const attempts = Promise.allSettled(Array.from({ length: 4 }, () => dial(url, {})));
      await vi.waitFor(() => expect(generate).toHaveBeenCalled());
      resume();
      const results = await attempts;
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    },
  );

  it('releases capacity when an admitted handshake fails', async () => {
    const url = (await start({ mobile: { sockets: 1, socketsPerIp: 1 } })).replace('/mobile', '');
    vi.spyOn(relay!.io.engine, 'generateId').mockRejectedValueOnce(new Error('Failed handshake'));
    await expect(dial(url, {})).rejects.toThrow();
    expect((await dial(url, {})).connected).toBe(true);
  });

  it('allows the Origin header automatically added by native iOS and Android WebSockets', async () => {
    const url = await start();
    await dial(url, { role: 'desktop', key });
    const phone = await dial(
      url,
      { role: 'phone', route },
      {
        Origin: 'https://relay.frink.example',
        'X-Frink-Mobile': '1',
      },
    );
    expect(phone.connected).toBe(true);
  });

  it('enforces the binary frame cap before namespace handlers buffer a packet', async () => {
    const url = (await start()).replace('/mobile', '');
    const socket = await dial(url, {});
    socket.emit('unknown-event', Buffer.alloc(256 * 1024 + 1));
    await vi.waitFor(() => expect(socket.connected).toBe(false));
  });
});
