import type { Page } from '@playwright/test';
import { Decoder, Encoder, PacketType, type Packet } from 'socket.io-parser';
import {
  answerHandshake,
  generateDesktopKeyPair,
  encodeKey,
  encodeEnvelope,
  decodeEnvelope,
  type ChannelSession,
} from '../../../src/shared/lib/mobile-channel';
import {
  envelopeBodyParts,
  fromBase64,
  type MobileEnvelope,
} from '../../../src/shared/types/remote/mobile-envelope';
import type { MobileChatEvent } from '../../../src/shared/types/remote/mobile';

const desktop = generateDesktopKeyPair();
export const fixtureKey = encodeKey(desktop.publicKey);
export const fixtureRoute = 'c'.repeat(64);
/** A second paired computer, for switching between computers. */
const secondDesktop = generateDesktopKeyPair();
export const secondKey = encodeKey(secondDesktop.publicKey);
export const secondRoute = 'e'.repeat(64);
/** Every request the mock relay forwards names the route the phone dialled. */
export const ROUTE_HEADER = 'x-fixture-route';

/** A live chat watch the stand-in handed out: the channel it lives on and its last event's seq. */
type Watch = { send: (envelope: MobileEnvelope) => void; seq: number };
export type RelayEvents = {
  /** Seals one event frame for `sub` on the channel that watched it; the next seq by default.
   *  False when no such watch is open (never handed out, unwatched, or ended by a resync). */
  push(sub: string, event: MobileChatEvent, seq?: number): boolean;
  /** Every watch the relay has opened, oldest first: one is listed once events can reach it. */
  opened: string[];
};

/** The sub a `watchChat` answer handed out, if this exchange was one. */
function watchedSub(request: { path: string; chunks: number[] }, body: string) {
  if (request.path !== '/api') return undefined;
  const input: { type?: string } = JSON.parse(
    new TextDecoder().decode(new Uint8Array(request.chunks)),
  );
  if (input.type !== 'watchChat') return undefined;
  const answer: { data?: { sub?: string } } = JSON.parse(body);
  return answer.data?.sub;
}

/** The sub an `unwatchChat` request names, if this exchange was one. */
function unwatchedSub(request: { path: string; chunks: number[] }) {
  if (request.path !== '/api') return undefined;
  const input: { type?: string; sub?: string } = JSON.parse(
    new TextDecoder().decode(new Uint8Array(request.chunks)),
  );
  return input.type === 'unwatchChat' ? input.sub : undefined;
}

/** Actual phone crypto + Socket.IO framing; only the desktop's domain HTTP responses are mocked. */
export async function mockRelay(page: Page, origin: string): Promise<RelayEvents> {
  const watches = new Map<string, Watch>();
  const opened: string[] = [];
  await page.routeWebSocket(`${origin.replace('https:', 'wss:')}/socket.io/**`, (socket) => {
    const encoder = new Encoder();
    const decoder = new Decoder();
    let session: ChannelSession | undefined;
    let route = fixtureRoute;
    const requests = new Map<
      number,
      { path: string; headers: Record<string, string>; chunks: number[] }
    >();
    const send = (packet: Packet) => {
      for (const chunk of encoder.encode(packet))
        socket.send(typeof chunk === 'string' ? `4${chunk}` : Buffer.from(chunk));
    };
    const frame = (bytes: Uint8Array) =>
      send({ type: PacketType.EVENT, nsp: '/mobile', data: ['frame', bytes] });
    const sendOn = (envelope: MobileEnvelope) => frame(session!.seal(encodeEnvelope(envelope)));
    const handleEnvelope = (part: MobileEnvelope) => {
      if (part.t === 'cancel') requests.delete(part.id);
      if (part.t !== 'req') return;
      if (part.path)
        requests.set(part.id, { path: part.path, headers: part.headers ?? {}, chunks: [] });
      const request = requests.get(part.id)!;
      request.chunks.push(...fromBase64(part.body));
      if (!part.end) return;
      requests.delete(part.id);
      void page
        .evaluate(
          async ({ origin, request, route }) => {
            const response = await fetch(`${origin}${request.path}`, {
              method: 'POST',
              headers: { ...request.headers, 'x-fixture-route': route },
              body: new Uint8Array(request.chunks),
            });
            return { status: response.status, body: await response.text() };
          },
          { origin, request, route },
        )
        .then((response) => {
          const watched = response.status === 200 ? watchedSub(request, response.body) : undefined;
          if (watched) {
            watches.set(watched, { send: sendOn, seq: 0 });
            opened.push(watched);
          }
          const unwatched = unwatchedSub(request);
          if (unwatched) watches.delete(unwatched);
          for (const [index, partBody] of envelopeBodyParts(
            new TextEncoder().encode(response.body),
          ).entries())
            frame(
              session!.seal(
                encodeEnvelope({
                  t: 'res',
                  id: part.id,
                  ...partBody,
                  ...(index === 0 ? { status: response.status } : {}),
                }),
              ),
            );
        })
        .catch(() => socket.close());
    };
    decoder.on('decoded', async (packet) => {
      if (packet.type === PacketType.CONNECT) {
        route = (packet.data as { route?: string } | undefined)?.route ?? fixtureRoute;
        send({ type: PacketType.CONNECT, nsp: '/mobile', data: { sid: 'fixture-peer' } });
        return;
      }
      if (packet.type !== PacketType.EVENT || packet.data[0] !== 'frame') return;
      const bytes = new Uint8Array(packet.data[1]);
      if (!session) {
        const ready = answerHandshake(bytes, route === secondRoute ? secondDesktop : desktop)!;
        session = ready.session;
        frame(ready.ready);
      } else {
        handleEnvelope(decodeEnvelope(session.open(bytes)!) as MobileEnvelope);
      }
      if (packet.id !== undefined)
        send({ type: PacketType.ACK, nsp: '/mobile', id: packet.id, data: [true] });
    });
    socket.onMessage((message) => {
      if (typeof message === 'string') {
        if (message === '2') socket.send('3');
        else if (message.startsWith('4')) decoder.add(message.slice(1));
      } else decoder.add(message);
    });
    socket.onClose(() => {
      for (const [sub, watch] of watches) if (watch.send === sendOn) watches.delete(sub);
    });
    socket.send(
      `0${JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`,
    );
  });
  const push = (sub: string, event: MobileChatEvent, seq?: number) => {
    const watch = watches.get(sub);
    if (!watch) return false;
    watch.seq = seq ?? watch.seq + 1;
    if (event.ops.some((op) => op.op === 'resync')) watches.delete(sub);
    const body = Buffer.from(JSON.stringify(event)).toString('base64');
    watch.send({ t: 'evt', sub, seq: watch.seq, body });
    return true;
  };
  return { push, opened };
}
