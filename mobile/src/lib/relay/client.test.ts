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
import { closeMobileRelay, relayRequest } from './client';

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
  timeout() {
    return this;
  }
  async emitWithAck(_name: string, bytes: Uint8Array) {
    this.frames.push(bytes);
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
}
let socket: Socket;
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
  const failed = expect(result).rejects.toMatchObject({ status: 0 });
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
