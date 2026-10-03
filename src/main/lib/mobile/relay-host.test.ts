import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }));
vi.mock('../sentry', () => ({ captureContained: vi.fn() }));
import {
  decodeEnvelope,
  encodeEnvelope,
  startHandshake,
  type ChannelSession,
} from '../../../shared/lib/mobile-channel';
import {
  envelopeBodyParts,
  fromBase64,
  type MobileEnvelope,
} from '../../../shared/types/remote/mobile-envelope';
import { loadDesktopIdentity, routeOf, type DesktopIdentity } from './identity';
import { MobilePairingStore } from './pairing-store';
import { startRelayHost } from './relay-host';
import { createMobileApp } from './server';

type Handler = (...args: unknown[]) => void;

/** Stands in for the relay's /mobile namespace: records what the desktop emits, acks every frame. */
function fakeRelay() {
  const handlers = new Map<string, Handler>();
  const toPhone: { peerId: string; data: Uint8Array }[] = [];
  const disconnected: string[] = [];
  const socket = {
    connected: true,
    active: true,
    connect: vi.fn(),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    emit: (event: string, peerId: string) => {
      if (event === 'disconnect-peer') disconnected.push(peerId);
    },
    timeout: () => ({
      emitWithAck: async (_event: string, frame: { peerId: string; data: Uint8Array }) => {
        toPhone.push(frame);
        return true;
      },
    }),
    close: vi.fn(),
  };
  const connect = vi.fn(() => socket);
  const acks: unknown[] = [];
  const fire = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args);
  const fromPhone = (peerId: string, data: Uint8Array) =>
    handlers.get('frame')?.({ peerId, data }, (value: unknown) => acks.push(value));
  return { connect, socket, toPhone, disconnected, fromPhone, acks, fire };
}

const address = () => ({
  relay: 'https://relay.example',
  route: identity.route,
  key: 'K'.repeat(43),
  machine: 'Mac',
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

let directory: string;
let identity: DesktopIdentity;
let store: MobilePairingStore;
let relay: ReturnType<typeof fakeRelay>;
let host: ReturnType<typeof startRelayHost>;
const execute = vi.fn(async () => ({ queue: [] }));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-relay-host-'));
  identity = await loadDesktopIdentity(join(directory, 'identity.json'));
  store = new MobilePairingStore(join(directory, 'mobile.json'));
  await store.initialize();
  await store.enable();
  relay = fakeRelay();
  const app = createMobileApp(store, execute);
  host = startRelayHost({
    relay: 'https://relay.example',
    identity,
    fetch: (request) => app.fetch(request),
    authenticate: (token) => store.authenticate(token),
    connect: relay.connect as never,
  });
});
afterEach(async () => {
  host.close();
  await rm(directory, { recursive: true, force: true });
});

/** A phone that pinned `pinned` and talks through the fake relay as `peerId`. */
async function phone(peerId: string, pinned = identity.keyPair.publicKey) {
  const handshake = startHandshake(pinned);
  relay.fromPhone(peerId, Buffer.from(handshake.hello));
  await settle();
  const ready = relay.toPhone.filter((frame) => frame.peerId === peerId).at(-1);
  const session = ready ? handshake.finish(ready.data) : null;
  let nextId = 0;
  const send = async (path: string, body: unknown, token?: string) => {
    const id = nextId++;
    const before = relay.toPhone.length;
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    envelopeBodyParts(encodeEnvelope(body)).forEach((part, index) =>
      relay.fromPhone(
        peerId,
        Buffer.from(
          session!.seal(
            encodeEnvelope({ t: 'req', id, ...(index === 0 ? { path, headers } : {}), ...part }),
          ),
        ),
      ),
    );
    // A request answers once; a dropped channel never does.
    await vi.waitFor(() => {
      if (relay.disconnected.includes(peerId)) return;
      expect(relay.toPhone.length).toBeGreaterThan(before);
    });
    return reply(session!, relay.toPhone.slice(before), peerId);
  };
  return { session, send };
}

function reply(
  session: ChannelSession,
  frames: { peerId: string; data: Uint8Array }[],
  peerId: string,
) {
  const parts = frames
    .filter((frame) => frame.peerId === peerId)
    .map((frame) => decodeEnvelope(session.open(frame.data)!) as MobileEnvelope);
  const first = parts[0] as { status: number } | undefined;
  const bytes = parts.flatMap((part) => [...fromBase64((part as { body: string }).body)]);
  return {
    status: first?.status,
    json: bytes.length ? JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) : null,
  };
}

describe('mobile relay host', () => {
  it('claims its route with the secret key and serves an encrypted pair-then-request flow', async () => {
    expect(relay.connect).toHaveBeenCalledWith('https://relay.example/mobile', {
      transports: ['websocket'],
      auth: { role: 'desktop', key: identity.routeKey },
    });
    expect(identity.route).toBe(routeOf(identity.routeKey));
    const { pairing } = await store.pair(address());
    const iphone = await phone('peer-1');
    expect(iphone.session).not.toBeNull();
    const paired = await iphone.send('/pair', { code: pairing.code, name: 'iPhone' });
    expect(paired.status).toBe(200);
    const overview = await iphone.send('/api', { type: 'overview' }, paired.json.token);
    expect(overview).toEqual({ status: 200, json: { data: { queue: [] } } });
    // Nothing on the relay's side of the wire is plaintext.
    for (const frame of relay.toPhone)
      expect(Buffer.from(frame.data).toString('latin1')).not.toContain('queue');
    expect(relay.acks.length).toBeGreaterThan(0);
    expect(relay.acks.every((value) => value === true)).toBe(true);
  });

  it('refuses a reused or expired code without opening anything else', async () => {
    const { pairing } = await store.pair(address());
    const first = await phone('peer-1');
    expect((await first.send('/pair', { code: pairing.code, name: 'A' })).status).toBe(200);
    const thief = await phone('peer-2');
    expect((await thief.send('/pair', { code: pairing.code, name: 'B' })).status).toBe(401);
    expect((await thief.send('/api', { type: 'overview' })).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a phone pinning another key cannot finish the handshake', async () => {
    const other = await loadDesktopIdentity(join(directory, 'other.json'));
    expect((await phone('peer-1', other.keyPair.publicKey)).session).toBeNull();
  });

  it('drops a channel whose frame was tampered with or replayed', async () => {
    const iphone = await phone('peer-1');
    const frame = iphone.session!.seal(encodeEnvelope({ t: 'cancel', id: 0 }));
    relay.fromPhone('peer-1', Buffer.from(frame));
    relay.fromPhone('peer-1', Buffer.from(frame));
    expect(relay.disconnected).toEqual(['peer-1']);
    const forged = await phone('peer-2');
    const bytes = forged.session!.seal(encodeEnvelope({ t: 'cancel', id: 0 }));
    bytes[bytes.length - 1] ^= 1;
    relay.fromPhone('peer-2', Buffer.from(bytes));
    expect(relay.disconnected).toEqual(['peer-1', 'peer-2']);
  });

  it('drops a peer whose first frame is not a hello', () => {
    relay.fromPhone('peer-1', Buffer.from(new Uint8Array(40)));
    expect(relay.disconnected).toEqual(['peer-1']);
  });

  it('severs exactly the channels of a revoked phone, at once', async () => {
    const tokens: string[] = [];
    const ids: string[] = [];
    for (const name of ['A', 'B']) {
      const { pairing } = await store.pair(address());
      const result = await store.redeem(pairing.code, name);
      tokens.push(result.token);
      ids.push(result.deviceId);
    }
    const a = await phone('peer-a');
    const b = await phone('peer-b');
    await a.send('/api', { type: 'overview' }, tokens[0]);
    await b.send('/api', { type: 'overview' }, tokens[1]);
    await store.revoke(ids[0]);
    host.sever((token) => !store.authenticate(token));
    expect(relay.disconnected).toEqual(['peer-a']);
    expect((await b.send('/api', { type: 'overview' }, tokens[1])).status).toBe(200);
  });

  it('reclaims its route itself when the relay refuses or drops it, and stops once closed', () => {
    vi.useFakeTimers();
    try {
      relay.socket.active = false;
      relay.fire('connect_error', new Error('Mobile connection unavailable.'));
      vi.advanceTimersByTime(5_000);
      expect(relay.socket.connect).toHaveBeenCalledTimes(1);
      relay.fire('disconnect', 'io server disconnect');
      host.close();
      vi.advanceTimersByTime(5_000);
      expect(relay.socket.connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees a phone slot held by a dialler that never says hello or never authenticates', async () => {
    vi.useFakeTimers();
    try {
      relay.fire('peer-connected', 'idle');
      vi.advanceTimersByTime(10_000);
      expect(relay.disconnected).toEqual(['idle']);

      relay.fire('peer-connected', 'squatter');
      relay.fromPhone('squatter', Buffer.from(startHandshake(identity.keyPair.publicKey).hello));
      // A repeated announcement must not reset the squatter to an already-met hello deadline.
      relay.fire('peer-connected', 'squatter');
      vi.advanceTimersByTime(30_000);
      expect(relay.disconnected).toEqual(['idle', 'squatter']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a phone that proved a paired token in time', async () => {
    const { pairing } = await store.pair(address());
    const { token } = await store.redeem(pairing.code, 'Phone');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      relay.fire('peer-connected', 'peer-1');
      const iphone = await phone('peer-1');
      expect((await iphone.send('/api', { type: 'overview' }, token)).status).toBe(200);
      vi.advanceTimersByTime(60_000);
      expect(relay.disconnected).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a real phone in while squatters keep redialling, by evicting the oldest unproven', async () => {
    const { pairing } = await store.pair(address());
    const { token } = await store.redeem(pairing.code, 'Phone');
    for (let index = 0; index < 6; index++) relay.fire('peer-connected', `squatter-${index}`);
    expect(relay.disconnected).toEqual(['squatter-0', 'squatter-1']);
    relay.fire('peer-connected', 'phone');
    expect(relay.disconnected).toContain('squatter-2');
    const iphone = await phone('phone');
    expect((await iphone.send('/api', { type: 'overview' }, token)).status).toBe(200);
    // Proven now, so later squatters evict each other rather than the phone.
    for (let index = 6; index < 12; index++) relay.fire('peer-connected', `squatter-${index}`);
    expect(relay.disconnected).not.toContain('phone');
  });

  it('sends nothing on a channel broken while its request was still running', async () => {
    const { pairing } = await store.pair(address());
    const { token } = await store.redeem(pairing.code, 'Phone');
    let release: (response: Response) => void = () => {};
    execute.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ queue: [] }))) as never,
    );
    const iphone = await phone('peer-1');
    const pending = iphone.send('/api', { type: 'overview' }, token);
    await settle();
    // A forged frame breaks the desktop's session while the request is still running.
    relay.fromPhone('peer-1', Buffer.from(new Uint8Array(64)));
    const sentBefore = relay.toPhone.length;
    release(new Response());
    await pending;
    expect(relay.disconnected).toContain('peer-1');
    expect(relay.toPhone.length).toBe(sentBefore);
  });
});
