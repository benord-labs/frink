/** Hosts this desktop's route on the relay: each phone that dials it gets an encrypted channel whose
 * requests run against the mobile Hono app in-process. The relay only ever carries ciphertext. */

import log from 'electron-log';
import { io as connect, type Socket } from 'socket.io-client';
import {
  answerHandshake,
  decodeEnvelope,
  encodeEnvelope,
  type ChannelSession,
} from '../../../shared/lib/mobile-channel';
import { mobileEnvelopeSchema } from '../../../shared/types/remote/mobile-envelope';
import { createBodyBudget, createChannelBridge, type ChannelBridge } from './channel-bridge';
import type { DesktopIdentity } from './identity';

/** A frame the relay has not acknowledged by then means that phone is gone or too slow. The relay
 * gives up at 15 s, so its own disconnect normally arrives first. */
const SEND_TIMEOUT_MS = 20_000;
/** Phones this desktop keeps channels for, whatever the relay sends; pairing allows 20 devices. */
const MAX_PEERS = 32;
/** Request bytes all channels together may hold: one full attachment plus room for the rest. */
const BODY_BUDGET_BYTES = 48 * 1024 * 1024;
/** Anyone holding the route (an old QR) can dial it, so a dialler must say hello, then prove a paired
 * token or finish pairing, in time; otherwise it would sit on one of the relay's 20 phone slots. */
const HELLO_DEADLINE_MS = 10_000;
const AUTH_DEADLINE_MS = 30_000;
/** Diallers still proving themselves at once. A newcomer evicts the oldest, so holding the relay's
 * phone slots against a real phone (which proves itself in about a second) outpaces per-IP limits. */
const MAX_UNPROVEN = 4;
/** socket.io only retries transport failures; a refused claim or a relay-side disconnect is ours to retry. */
const RECLAIM_DELAY_MS = 5_000;

/** socket.io hands binary over as a Buffer (a Uint8Array) or an ArrayBuffer. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  return data instanceof ArrayBuffer ? new Uint8Array(data) : null;
}

type Peer = { session: ChannelSession; bridge: ChannelBridge; sending: Promise<unknown> };

export type RelayHost = {
  /** Closes every channel whose bearer token `revoked` rejects, at once. */
  sever(revoked: (token: string) => boolean): void;
  connected(): boolean;
  close(): void;
};

export function startRelayHost(options: {
  relay: string;
  identity: DesktopIdentity;
  fetch: (request: Request) => Response | Promise<Response>;
  authenticate: (token: string) => boolean;
  connect?: typeof connect;
}): RelayHost {
  const budget = createBodyBudget(BODY_BUDGET_BYTES);
  const socket: Socket = (options.connect ?? connect)(`${options.relay}/mobile`, {
    transports: ['websocket'],
    auth: { role: 'desktop', key: options.identity.routeKey },
  });
  const peers = new Map<string, Peer>();
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  const forget = (peerId: string) => {
    clearTimeout(deadlines.get(peerId));
    deadlines.delete(peerId);
    peers.get(peerId)?.bridge.close();
    peers.delete(peerId);
  };
  const drop = (peerId: string) => {
    forget(peerId);
    socket.emit('disconnect-peer', peerId);
  };
  /** A late failure from an earlier channel must not drop a newer one under the same id. */
  const dropIfCurrent = (peerId: string, peer: Peer) => {
    if (peers.get(peerId) === peer) drop(peerId);
  };
  /** Drops `peerId` after `ms` unless `kept()` says it has earned its slot by then. */
  const deadline = (peerId: string, ms: number, kept: () => boolean) => {
    clearTimeout(deadlines.get(peerId));
    deadlines.set(
      peerId,
      setTimeout(() => (kept() ? deadlines.delete(peerId) : drop(peerId)), ms),
    );
  };
  const authenticated = (peer: Peer) => [...peer.bridge.tokens()].some(options.authenticate);
  const admit = (peerId: string) => {
    // A repeated announcement must not swap a running auth deadline for an already-met hello one.
    if (peers.has(peerId) || deadlines.has(peerId)) return;
    const unproven = [...deadlines.keys()].filter((id) => {
      const peer = peers.get(id);
      return !peer || !authenticated(peer);
    });
    const excess = unproven.length - MAX_UNPROVEN + 1;
    for (const id of unproven.slice(0, Math.max(0, excess))) drop(id);
    deadline(peerId, HELLO_DEADLINE_MS, () => peers.has(peerId));
  };

  const emit = (peerId: string, data: Uint8Array) =>
    socket.timeout(SEND_TIMEOUT_MS).emitWithAck('frame', { peerId, data });

  const handshake = (peerId: string, hello: Uint8Array) => {
    const answer = peers.size < MAX_PEERS && answerHandshake(hello, options.identity.keyPair);
    if (!answer) return drop(peerId);
    const peer: Peer = {
      session: answer.session,
      sending: emit(peerId, answer.ready).catch(() => dropIfCurrent(peerId, peer)),
      bridge: createChannelBridge({
        fetch: options.fetch,
        // Seal now so counters follow call order; the relay acks each frame before the next goes.
        send: (envelope) => {
          // A broken or exhausted session refuses to seal; that channel is over.
          let frame: Uint8Array;
          try {
            frame = peer.session.seal(encodeEnvelope(envelope));
          } catch {
            return drop(peerId);
          }
          peer.sending = peer.sending
            .then(() => peers.get(peerId) === peer && emit(peerId, frame))
            .catch(() => dropIfCurrent(peerId, peer));
        },
        fail: () => drop(peerId),
        authenticate: options.authenticate,
        budget,
      }),
    };
    peers.set(peerId, peer);
    deadline(peerId, AUTH_DEADLINE_MS, () => authenticated(peer));
  };

  const receive = (peerId: string, data: Uint8Array) => {
    const peer = peers.get(peerId);
    if (!peer) return handshake(peerId, data);
    const plain = peer.session.open(data);
    const envelope = plain && mobileEnvelopeSchema.safeParse(decodeEnvelope(plain));
    if (!envelope?.success) return drop(peerId);
    peer.bridge.receive(envelope.data);
  };

  socket.on('frame', (frame: { peerId?: unknown; data?: unknown } | undefined, ack?: unknown) => {
    // Accepting a frame is acknowledging it; the relay paces the phone's next frame on this.
    if (typeof ack === 'function') ack(true);
    const data = bytesOf(frame?.data);
    if (typeof frame?.peerId === 'string' && data) receive(frame.peerId, data);
  });
  socket.on('peer-connected', (peerId: unknown) => {
    if (typeof peerId === 'string') admit(peerId);
  });
  socket.on('peer-disconnected', (peerId: unknown) => {
    if (typeof peerId === 'string') forget(peerId);
  });
  let closed = false;
  let reclaim: ReturnType<typeof setTimeout> | undefined;
  const retry = () => {
    if (closed || socket.active) return;
    clearTimeout(reclaim);
    reclaim = setTimeout(() => !closed && socket.connect(), RECLAIM_DELAY_MS);
  };
  socket.on('disconnect', () => {
    for (const peerId of [...deadlines.keys(), ...peers.keys()]) forget(peerId);
    retry();
  });
  socket.on('connect_error', (error) => {
    log.warn('[Mobile] Relay unavailable:', error.message);
    retry();
  });

  return {
    sever(revoked) {
      for (const [peerId, peer] of peers) {
        if ([...peer.bridge.tokens()].some(revoked)) drop(peerId);
      }
    },
    connected: () => socket.connected,
    close() {
      closed = true;
      clearTimeout(reclaim);
      for (const peerId of [...deadlines.keys(), ...peers.keys()]) forget(peerId);
      socket.close();
    },
  };
}
