import type { AppStateStatus } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('expo-crypto', () => ({
  getRandomBytes: (size: number) => crypto.getRandomValues(new Uint8Array(size)),
}));
const wire = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: wire.io }));
import {
  answerHandshake,
  generateDesktopKeyPair,
  encodeKey,
  encodeEnvelope,
  decodeEnvelope,
  type ChannelSession,
} from '@frink/shared/lib/mobile-channel';
import { envelopeBodyParts, type MobileEnvelope } from '@frink/shared/types/remote/mobile-envelope';
import type { MobileChatDetail } from '@frink/shared/types/remote/mobile';
import { ChatStream, type ChatStreamDeps } from '../chat/stream';
import { closeMobileRelay, relayLink, relayRequest, watchRelayLifecycle } from './client';
import { LinkLost } from './error';

const desktop = generateDesktopKeyPair();
const target = {
  relay: 'https://relay.test',
  route: 'a'.repeat(64),
  key: encodeKey(desktop.publicKey),
};
const input = new TextEncoder().encode('{"type":"flows"}');
class Socket {
  handlers = new Map<string, (...args: any[]) => void>();
  session?: ChannelSession;
  parts: MobileEnvelope[] = [];
  frames: Uint8Array[] = [];
  response = true;
  wrongKey = false;
  keyPair = desktop;
  delayAck?: Promise<void>;
  /** Swallows application frames unacknowledged, like a link that died without closing. */
  silent = false;
  ackMs: number[] = [];
  disconnected = false;
  on(name: string, fn: (...args: any[]) => void) {
    this.handlers.set(name, fn);
    return this;
  }
  connect() {
    queueMicrotask(() => this.handlers.get('connect')?.());
  }
  disconnect() {
    this.disconnected = true;
    this.handlers.get('disconnect')?.();
  }
  timeout(ms: number) {
    this.ackMs.push(ms);
    return this;
  }
  async emitWithAck(_name: string, bytes: Uint8Array) {
    this.frames.push(bytes);
    const ackMs = this.ackMs.at(-1);
    if (this.silent && this.session)
      await new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ackMs));
    if (!this.session) {
      const ready = answerHandshake(
        bytes,
        this.wrongKey ? generateDesktopKeyPair() : this.keyPair,
      )!;
      this.session = ready.session;
      this.handlers.get('frame')?.(ready.ready, () => {});
    } else {
      const plain = this.session.open(bytes);
      if (!plain) throw new Error('Invalid phone ciphertext');
      const part = decodeEnvelope(plain) as MobileEnvelope;
      this.parts.push(part);
      if (this.response && part.t === 'req' && part.end)
        this.reply(part.id, new TextEncoder().encode('{"data":[]}'));
    }
    await this.delayAck;
    return true;
  }
  reply(id: number, bytes: Uint8Array) {
    for (const [index, part] of envelopeBodyParts(bytes).entries()) {
      const frame = this.session!.seal(
        encodeEnvelope({ t: 'res', id, ...part, ...(index === 0 ? { status: 200 } : {}) }),
      );
      this.handlers.get('frame')?.(frame, () => {});
    }
  }
  event(sub: string, seq: number, text: string) {
    const body = btoa(text);
    this.handlers.get('frame')?.(this.session!.seal(encodeEnvelope({ t: 'evt', sub, seq, body })));
  }
}
const SUB = '00000000-0000-4000-8000-00000000000a';
let socket: Socket;
function watchLifecycle() {
  let onChange!: (state: AppStateStatus) => void;
  const remove = vi.fn();
  const unwatch = watchRelayLifecycle({
    addEventListener: (_type, listener) => {
      onChange = listener;
      return { remove };
    },
  });
  return { onChange: (state: AppStateStatus) => onChange(state), unwatch, remove };
}
/** Later dials get a fresh socket; returns the one in use so far. */
function swapSocket() {
  const previous = socket;
  socket = new Socket();
  wire.io.mockReturnValue(socket);
  return previous;
}
beforeEach(() => {
  socket = new Socket();
  wire.io.mockReturnValue(socket);
});
afterEach(() => {
  closeMobileRelay();
  vi.clearAllMocks();
});
it('authenticates the pinned desktop, keeps bearer encrypted, and multiplexes requests', async () => {
  const results = await Promise.all([
    relayRequest(target, '/api', { Authorization: 'Bearer private' }, input),
    relayRequest(target, '/api', {}, input),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(wire.io).toHaveBeenCalledOnce();
  expect(wire.io.mock.calls[0][1].extraHeaders).toEqual({ 'X-Frink-Mobile': '1' });
  expect(wire.io.mock.calls[0][1].auth).toEqual({ role: 'phone', route: target.route });
  expect(socket.parts.filter((p) => p.t === 'req').map((p) => p.id)).toEqual([0, 1]);
  expect(socket.frames.map((f) => new TextDecoder().decode(f)).join('')).not.toContain('private');
});
it('rejects another desktop before sending any application bytes', async () => {
  socket.wrongKey = true;
  await expect(relayRequest(target, '/api', {}, input)).rejects.toMatchObject({ status: 0 });
  expect(socket.parts).toEqual([]);
  expect(socket.disconnected).toBe(true);
});
it('reassembles responses larger than one frame', async () => {
  socket.response = false;
  const result = relayRequest(target, '/api', {}, input);
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  const body = new Uint8Array(400_000).fill(123);
  socket.reply(0, body);
  expect((await result).body).toEqual(body);
});
it('fragments uploads, waiting for each ACK before sending the next part', async () => {
  let acknowledge!: () => void;
  socket.delayAck = new Promise<void>((r) => {
    acknowledge = r;
  });
  const result = relayRequest(target, '/api/attachments', {}, new Uint8Array(300_000));
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  expect(socket.frames.every((f) => f.byteLength <= 256 * 1024)).toBe(true);
  acknowledge();
  await result;
  expect(socket.parts.filter((p) => p.t === 'req')).toHaveLength(3);
});
it('disconnect fails pending work and never resends it; a later request handshakes again', async () => {
  socket.response = false;
  const result = relayRequest(target, '/api', {}, input);
  const failed = expect(result).rejects.toBeInstanceOf(LinkLost);
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  socket.disconnect();
  await failed;
  expect(socket.parts).toHaveLength(1);
  const replacement = new Socket();
  wire.io.mockReturnValue(replacement);
  await relayRequest(target, '/api', {}, input);
  expect(replacement.parts).toHaveLength(1);
});
it('a request to another computer lets the previous one finish, then closes it', async () => {
  socket.response = false;
  const last = relayRequest(target, '/api/notifications', {}, input);
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  const previous = socket;
  const other = generateDesktopKeyPair();
  socket = new Socket();
  socket.keyPair = other;
  wire.io.mockReturnValue(socket);
  const otherTarget = { ...target, route: 'b'.repeat(64), key: encodeKey(other.publicKey) };
  const next = relayRequest(otherTarget, '/api', {}, input);
  expect(previous.disconnected).toBe(false);
  previous.reply(0, new TextEncoder().encode('{"data":null}'));
  expect((await last).status).toBe(200);
  expect(previous.disconnected).toBe(true);
  expect((await next).status).toBe(200);
});
it('a request that times out on a live link fails without marking the link lost', async () => {
  socket.response = false;
  const error = await relayRequest(target, '/api', {}, input, undefined, 50).catch((e) => e);
  expect(error).toMatchObject({ status: 0 });
  expect(error).not.toBeInstanceOf(LinkLost);
  expect(socket.disconnected).toBe(false);
});
it('cancellation drops a late response without corrupting the session', async () => {
  socket.response = false;
  const controller = new AbortController();
  const result = relayRequest(target, '/api', {}, input, controller.signal);
  const failed = expect(result).rejects.toMatchObject({ status: 0 });
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  controller.abort();
  await failed;
  socket.reply(0, input);
  socket.response = true;
  expect((await relayRequest(target, '/api', {}, input)).status).toBe(200);
});
it('drops tampered frames and fails all pending requests', async () => {
  socket.response = false;
  const result = relayRequest(target, '/api', {}, input);
  const failed = expect(result).rejects.toMatchObject({ status: 0 });
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  socket.handlers.get('frame')?.(new Uint8Array(32));
  await failed;
  expect(socket.disconnected).toBe(true);
});
it('fails an /api request as a lost link and closes the client once its frame goes unacknowledged for 10 s', async () => {
  vi.useFakeTimers();
  try {
    socket.silent = true;
    const result = relayRequest(target, '/api', {}, input);
    const failed = expect(result).rejects.toBeInstanceOf(LinkLost);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(socket.disconnected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('gives attachment parts 20 s to be acknowledged and other frames 10 s', async () => {
  await relayRequest(target, '/api/attachments', {}, input);
  await relayRequest(target, '/api', {}, input);
  expect(socket.ackMs).toEqual([10_000, 20_000, 10_000]);
});
it('acks an incoming frame before reading it, then closes on one that does not decrypt', async () => {
  await relayRequest(target, '/api', {}, input);
  const ack = vi.fn();
  socket.handlers.get('frame')?.(new Uint8Array(32), ack);
  expect(ack).toHaveBeenCalledOnce();
  expect(socket.disconnected).toBe(true);
});
it('a deliberate close fails what is in flight without marking the link lost', async () => {
  socket.response = false;
  const error = relayRequest(target, '/api', {}, input).catch((e) => e);
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  closeMobileRelay();
  expect(await error).toMatchObject({ status: 0 });
  expect(await error).not.toBeInstanceOf(LinkLost);
});
it('returning to the foreground redials even when a request dialled while away', async () => {
  const { onChange } = watchLifecycle();
  onChange('background');
  await relayRequest(target, '/api', {}, input);
  const dialledAway = swapSocket();
  onChange('active');
  expect(wire.io).toHaveBeenCalledTimes(2);
  expect(dialledAway.disconnected).toBe(true);
});
it('a retired client lets a slow request run to its own timeout', async () => {
  vi.useFakeTimers();
  try {
    const { onChange } = watchLifecycle();
    socket.response = false;
    const created = relayRequest(target, '/api', {}, input, undefined, 60_000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.parts).toHaveLength(1);
    onChange('background');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(socket.disconnected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await created).toMatchObject({ status: 0 });
    expect(socket.disconnected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
it('retires the client in the background without failing what is in flight, and redials on return', async () => {
  const { onChange, unwatch, remove } = watchLifecycle();
  socket.response = false;
  const inFlight = relayRequest(target, '/api', {}, input);
  await vi.waitFor(() => expect(socket.parts).toHaveLength(1));
  const previous = swapSocket();
  onChange('background');
  expect(previous.disconnected).toBe(false);
  previous.reply(0, input);
  expect((await inFlight).status).toBe(200);
  expect(previous.disconnected).toBe(true);
  onChange('active');
  expect(wire.io).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(socket.frames).toHaveLength(1));
  unwatch();
  expect(remove).toHaveBeenCalledOnce();
});
it('delivers an event frame to its watch, drops one for an unknown watch, and stays open', async () => {
  await relayRequest(target, '/api', {}, input);
  const link = relayLink(target);
  const handler = vi.fn();
  link.listen(SUB, handler);
  socket.event(SUB, 1, '{"ops":[]}');
  socket.event('00000000-0000-4000-8000-00000000000b', 1, '{"ops":[]}');
  expect(handler).toHaveBeenCalledWith(1, new TextEncoder().encode('{"ops":[]}'));
  expect(handler).toHaveBeenCalledOnce();
  expect(socket.disconnected).toBe(false);
  expect(link.lost).toBe(false);
});
it('a retired link drops its watches at once, tells them just after, and the next request dials anew', async () => {
  const { onChange } = watchLifecycle();
  await relayRequest(target, '/api', {}, input);
  const link = relayLink(target);
  const handler = vi.fn();
  const lost = vi.fn();
  link.listen(SUB, handler);
  link.onLost(lost);
  const previous = swapSocket();
  onChange('background');
  expect(lost).not.toHaveBeenCalled();
  expect(link.lost).toBe(true);
  previous.event(SUB, 1, '{"ops":[]}');
  expect(handler).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(lost).toHaveBeenCalledWith(false));
  expect(relayLink(target)).not.toBe(link);
});

const chat: MobileChatDetail = {
  ...{ chat: { id: 'chat', name: 'Chat', projectId: null }, subChatId: 'sub', subChats: [] },
  ...{ messages: [], hasMore: false, activity: 'idle', kind: 'chat', error: null },
  ...{ questions: [], permissions: [], pendingPlanId: null },
};
/** Starts a live stream of one chat on the real link to `target`, once that link is up. */
async function liveStream() {
  await relayRequest(target, '/api', {}, input);
  const deps = {
    link: () => relayLink(target),
    watch: vi.fn(async () => ({ sub: SUB, detail: chat })),
    unwatch: vi.fn<(sub: string) => void>(),
    canWatch: () => true,
    show: vi.fn<(detail: MobileChatDetail) => void>(),
    first: () => undefined,
    live: vi.fn<(live: boolean) => void>(),
    conversation: 'relay-chat',
  } satisfies ChatStreamDeps;
  new ChatStream(deps).start();
  await vi.waitFor(() => expect(deps.live).toHaveBeenLastCalledWith(true));
  return deps;
}
it('forgetting the computer under a live watch ends the watch and dials nothing', async () => {
  const deps = await liveStream();
  const forgotten = socket;
  closeMobileRelay();
  await vi.waitFor(() => expect(deps.live).toHaveBeenLastCalledWith(false));
  forgotten.event(SUB, 1, '{"ops":[]}');
  expect(deps.show).toHaveBeenCalledOnce();
  expect(deps.watch).toHaveBeenCalledOnce();
  expect(wire.io).toHaveBeenCalledOnce();
});
it('a link that dies under a live watch watches again on a newly dialled one', async () => {
  const deps = await liveStream();
  swapSocket().disconnect();
  await vi.waitFor(() => expect(deps.watch).toHaveBeenCalledTimes(2));
  expect(wire.io).toHaveBeenCalledTimes(2);
  expect(deps.live).toHaveBeenLastCalledWith(true);
});
it('coming back to the foreground watches again exactly once, on the newly dialled link', async () => {
  const { onChange } = watchLifecycle();
  onChange('background');
  const deps = await liveStream();
  swapSocket();
  onChange('active');
  await vi.waitFor(() => expect(deps.watch).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(deps.live).toHaveBeenLastCalledWith(true));
  expect(wire.io).toHaveBeenCalledTimes(2);
});
