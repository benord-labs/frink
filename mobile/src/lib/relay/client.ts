import { getRandomBytes } from 'expo-crypto';
import nacl from 'tweetnacl';
import type { AppStateStatic } from 'react-native';
import { io, type Socket } from 'socket.io-client';
import {
  decodeEnvelope,
  decodeKey,
  encodeEnvelope,
  startHandshake,
  type ChannelSession,
} from '@frink/shared/lib/mobile-channel';
import {
  envelopeBodyParts,
  fromBase64,
  mobileEnvelopeSchema,
  MOBILE_ENVELOPE_PART_BYTES,
  type MobileEnvelope,
} from '@frink/shared/types/remote/mobile-envelope';
import { ApiError, linkLost, unreachable } from './error';

// Metro resolves the shared channel’s tweetnacl to this same mobile dependency.
nacl.setPRNG((target, length) => {
  const bytes = getRandomBytes(length);
  if (bytes.length !== length) throw new Error('Secure randomness unavailable.');
  target.set(bytes);
});

export type RelayTarget = { relay: string; route: string; key: string };
type RequestPath = Extract<MobileEnvelope, { t: 'req' }>['path'];
type ResponseBody = { status: number; body: Uint8Array };
type Pending = {
  chunks: Uint8Array[];
  size: number;
  status?: number;
  finish: (result?: ResponseBody, error?: Error) => void;
};
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** A frame the relay has not acknowledged by then means the link is dead. */
const FRAME_ACK_MS = 10_000;
/** Attachment parts are large, so a slow mobile uplink gets longer before it counts as dead. */
const UPLOAD_ACK_MS = 20_000;
/** Receives one live chat event frame: its sequence number and decoded JSON body. */
export type RelayEventHandler = (seq: number, body: Uint8Array) => void;
/** The client a request to a computer travels on. Live watches belong to it and end with it. */
export type RelayLink = {
  /** True once retired or closed: its watches are gone, and later requests dial a new client. */
  readonly lost: boolean;
  /** Delivers `evt` frames for `sub` until the returned function is called or the link is lost. */
  listen(sub: string, handler: RelayEventHandler): () => void;
  /** Called once, just after the link is lost; `gone` when it was closed on purpose, so its
   * computer must not be watched again. */
  onLost(listener: (gone: boolean) => void): () => void;
};
const DEV = typeof __DEV__ !== 'undefined' && __DEV__;

function devLog(message: string) {
  if (DEV) console.log(`[relay] ${message}`);
}

function frameBytes(data: unknown): Uint8Array {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : null;
  if (!bytes || bytes.length > 256 * 1024) throw new Error('Invalid frame.');
  return bytes;
}

/** Adds one response part to its request, checking the parts agree and fit. */
function collectPart(item: Pending, part: Extract<MobileEnvelope, { t: 'res' }>) {
  if ((item.status === undefined) !== (part.status !== undefined))
    throw new Error('Invalid response parts.');
  if (part.status !== undefined) item.status = part.status;
  const bytes = fromBase64(part.body);
  item.size += bytes.length;
  if (bytes.length > MOBILE_ENVELOPE_PART_BYTES || item.size > MAX_RESPONSE_BYTES)
    throw new Error('Response too large.');
  item.chunks.push(bytes);
}

function joinChunks({ chunks, size }: Pending) {
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** One authenticated session; a disconnect fails every request, never replays it. */
class RelayClient implements RelayLink {
  private socket: Socket;
  private session: ChannelSession | null = null;
  private ready: Promise<void>;
  private sendQueue = Promise.resolve();
  private pending = new Map<number, Pending>();
  private nextId = 0;
  closed = false;
  private retiring = false;
  private events = new Map<string, RelayEventHandler>();
  private lostListeners = new Set<(gone: boolean) => void>();
  private failHandshake: (error: Error) => void = () => {};

  constructor(target: RelayTarget) {
    const key = decodeKey(target.key);
    if (!key) throw new Error('Invalid desktop key.');
    const handshake = startHandshake(key);
    this.socket = io(`${target.relay.replace(/\/$/, '')}/mobile`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      auth: { role: 'phone', route: target.route },
      // Native WebSockets send Origin too; this header distinguishes them from browser scripts.
      extraHeaders: { 'X-Frink-Mobile': '1' },
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.close('handshake timed out'), 15_000);
      this.failHandshake = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      this.socket.on('connect', () => {
        void this.socket
          .timeout(FRAME_ACK_MS)
          .emitWithAck('frame', handshake.hello)
          .catch(() => this.close('hello not acknowledged'));
      });
      this.socket.on('frame', (data: unknown, ack?: () => void) => {
        // Ack on arrival, as the desktop does: the relay paces the sender on it, and a bad frame
        // closes this client below anyway.
        ack?.();
        try {
          const bytes = frameBytes(data);
          if (!this.session) {
            this.session = handshake.finish(bytes);
            if (!this.session) throw new Error('Desktop identity does not match.');
            clearTimeout(timeout);
            resolve();
          } else {
            const plain = this.session.open(bytes);
            if (!plain) throw new Error('Invalid encrypted frame.');
            this.receive(mobileEnvelopeSchema.parse(decodeEnvelope(plain)));
          }
        } catch {
          this.close('invalid frame');
        }
      });
    });
    // A user may cancel while the handshake is pending; retain a rejection handler regardless.
    void this.ready.catch(() => {});
    this.socket.on('disconnect', (reason) => this.close(`disconnected: ${reason}`));
    this.socket.on('connect_error', () => this.close('relay unreachable'));
    this.socket.connect();
  }

  /** A `deliberate` close fails in-flight requests outright and ends its watches for good; any
   * other is a lost link, so reads may ask again and watches move to the next link. */
  close(reason = 'closed', deliberate = false) {
    if (this.closed) return;
    this.closed = true;
    devLog(`closed: ${reason}`);
    const failure = deliberate ? unreachable : linkLost;
    this.failHandshake(failure());
    this.socket.disconnect();
    for (const item of this.pending.values()) item.finish(undefined, failure());
    this.pending.clear();
    this.loseWatches(deliberate);
  }

  /** Closes once in-flight requests settle; each is bounded by its own timeout. */
  retire() {
    this.retiring = true;
    this.loseWatches(false);
    if (this.pending.size === 0) this.close('retired');
  }

  get lost() {
    return this.closed || this.retiring;
  }

  listen(sub: string, handler: RelayEventHandler) {
    if (this.lost) return () => {};
    this.events.set(sub, handler);
    return () => {
      if (this.events.get(sub) === handler) this.events.delete(sub);
    };
  }

  onLost(listener: (gone: boolean) => void) {
    this.lostListeners.add(listener);
    return () => void this.lostListeners.delete(listener);
  }

  private loseWatches(gone: boolean) {
    this.events.clear();
    const listeners = [...this.lostListeners];
    this.lostListeners.clear();
    // Told once teardown has finished, so a listener that dials never re-enters it.
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener(gone);
    });
  }

  private receive(part: MobileEnvelope) {
    // An event for a watch no screen holds any more is dropped, as a late reply is.
    if (part.t === 'evt') return this.events.get(part.sub)?.(part.seq, fromBase64(part.body));
    if (part.t !== 'res') throw new Error('Unexpected envelope.');
    const item = this.pending.get(part.id);
    if (!item) return; // Late reply to a cancelled request.
    collectPart(item, part);
    if (part.end) item.finish({ status: item.status!, body: joinChunks(item) });
  }

  private send(part: MobileEnvelope, active: () => boolean, ackMs = FRAME_ACK_MS) {
    const next = this.sendQueue.then(async () => {
      if (!active()) return;
      if (this.closed || !this.session) throw unreachable();
      // Seal only as we emit, so concurrent requests cannot reorder nonce counters.
      // A missing ack closes the client here, so every pending request fails as a lost link.
      await this.socket
        .timeout(ackMs)
        .emitWithAck('frame', this.session.seal(encodeEnvelope(part)))
        .catch(() => this.close('frame not acknowledged'));
    });
    this.sendQueue = next.catch(() => {});
    return next;
  }

  request(
    path: RequestPath,
    headers: Record<string, string>,
    body: Uint8Array,
    signal?: AbortSignal,
    timeoutMs = 20_000,
  ): Promise<ResponseBody> {
    if (this.closed) return Promise.reject(unreachable());
    if (this.pending.size >= 8)
      return Promise.reject(new ApiError('Too many requests. Try again in a moment.', 429));
    if (body.length > (path === '/api/attachments' ? 20 * 1024 * 1024 : 128 * 1024))
      return Promise.reject(new ApiError('This file or message is too large.', 413));
    const id = this.nextId++;
    const queued = Date.now();
    let acked = '-';
    return new Promise((resolve, reject) => {
      const finish: Pending['finish'] = (result, error) => {
        devLog(
          `${path} #${id}: acked ${acked} ms, done ${Date.now() - queued} ms${error ? ', failed' : ''}`,
        );
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (this.retiring && this.pending.size === 0) this.close();
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => {
        finish(undefined, unreachable());
        if (this.session && !this.closed)
          void this.send({ t: 'cancel', id }, () => !this.closed).catch(() => {});
      };
      const timer = setTimeout(abort, timeoutMs);
      this.pending.set(id, { chunks: [], size: 0, finish });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      void this.ready
        .then(async () => {
          const parts = envelopeBodyParts(body);
          const ackMs = path === '/api/attachments' ? UPLOAD_ACK_MS : FRAME_ACK_MS;
          for (let i = 0; i < parts.length && this.pending.has(id); i++) {
            await this.send(
              { t: 'req', id, ...parts[i], ...(i === 0 ? { path, headers } : {}) },
              () => this.pending.has(id),
              ackMs,
            );
            if (i === 0) acked = String(Date.now() - queued);
          }
        })
        .catch(() => finish(undefined, unreachable()));
    });
  }
}

let cached: { identity: string; client: RelayClient } | undefined;
/** The computer last asked, so a returning app can dial it before its first poll. */
let lastTarget: RelayTarget | undefined;

/** A deliberate close: in-flight reads fail outright and watches end, never redialling it. */
export function closeMobileRelay() {
  cached?.client.close('closed', true);
  cached = undefined;
  lastTarget = undefined;
}

function clientFor(target: RelayTarget) {
  const identity = JSON.stringify([target.relay, target.route, target.key]);
  if (cached?.identity !== identity || cached.client.closed) {
    // Switching computers lets the previous one finish what is in flight, then closes it.
    cached?.client.retire();
    cached = { identity, client: new RelayClient(target) };
  }
  lastTarget = target;
  return cached.client;
}

/** The link the next request to `target` travels on, dialling one if needed. */
export const relayLink = (target: RelayTarget): RelayLink => clientFor(target);

export function relayRequest(
  target: RelayTarget,
  path: RequestPath,
  headers: Record<string, string>,
  body: Uint8Array,
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  return clientFor(target).request(path, headers, body, signal, timeoutMs);
}

function retireCached() {
  cached?.client.retire();
  cached = undefined;
}

/** iOS suspends a backgrounded app and its socket dies silently, so the client is retired on the
 * way out and again on return (in-flight requests still finish), then a fresh one dials. */
export function watchRelayLifecycle(appState: Pick<AppStateStatic, 'addEventListener'>) {
  let away = false;
  const subscription = appState.addEventListener('change', (state) => {
    if (state === 'background') {
      away = true;
      retireCached();
    } else if (state === 'active' && away) {
      away = false;
      // A client dialled while away may sit on a suspended socket.
      retireCached();
      if (lastTarget) clientFor(lastTarget);
    }
  });
  return () => subscription.remove();
}
