// A stand-in Mac for the iOS simulator: the real phone protocol over TLS on localhost, answering
// with the same fixtures the browser tests use. Setup (certificate, simulator trust): mobile/README.md.
import { appendFileSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Decoder, Encoder, PacketType, type Packet } from 'socket.io-parser';
import {
  answerHandshake,
  decodeEnvelope,
  encodeEnvelope,
  encodeKey,
  generateDesktopKeyPair,
  type ChannelSession,
} from '../../../src/shared/lib/mobile-channel';
import {
  envelopeBodyParts,
  fromBase64,
  type MobileEnvelope,
} from '../../../src/shared/types/remote/mobile-envelope';
import { mobilePairingLink } from '../../../src/shared/types/remote/mobile';
import { chatFixture, previewData } from './data';
import { flowFor, macFlows, runFor } from './flows';

const port = Number(process.env.SIM_RELAY_PORT ?? 8443);
const cert = process.env.SIM_RELAY_CERT ?? '/tmp/frink-sim-relay/cert.pem';
const key = process.env.SIM_RELAY_KEY ?? '/tmp/frink-sim-relay/key.pem';
// The phone pins this key when it pairs, so it is kept across restarts.
const keyFile = process.env.SIM_RELAY_DESKTOP_KEY ?? '/tmp/frink-sim-relay/desktop-key.json';
function readKeyPair() {
  const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<
    'publicKey' | 'secretKey',
    number[]
  >;
  return { publicKey: new Uint8Array(saved.publicKey), secretKey: new Uint8Array(saved.secretKey) };
}
function desktopKeyPair() {
  const made = generateDesktopKeyPair();
  const json = JSON.stringify({ publicKey: [...made.publicKey], secretKey: [...made.secretKey] });
  // Written in full beside the key file, then linked into place: a link is create-only and
  // atomic, so two relays started together serve the same saved key and never read half of one.
  const draft = `${keyFile}.${process.pid}`;
  writeFileSync(draft, json);
  try {
    linkSync(draft, keyFile);
    return made;
  } catch {
    return readKeyPair();
  } finally {
    rmSync(draft);
  }
}
const desktop = desktopKeyPair();
const data = previewData() as Record<string, unknown>;

/** chat-2 (the Queue's "Add dark mode to the pricing page") is a long idle transcript; the rest are the short one. */
function chatFor(id: string) {
  if (id === 'chat-new')
    return {
      ...chatFixture('idle'),
      chat: { id, name: 'New chat', projectId: 'project-1' },
      subChatId: 'sub-new',
      subChats: [{ id: 'sub-new', name: 'New chat', activity: 'idle' }],
      messages: sent,
    };
  if (id !== 'chat-2') return data.chat;
  const chat = chatFixture('idle');
  const messages = Array.from({ length: 40 }, (_, index) => {
    const text =
      index % 4 === 0
        ? `Step ${index / 4 + 1}: what about the pricing table?`
        : `Update ${index}: checked the **pricing page** styles and prepared the next change in \`theme.css\`.`;
    return {
      id: `long-${index}`,
      role: index % 4 === 0 ? 'user' : 'assistant',
      text,
      parts: [{ type: 'text', text }],
    };
  });
  return {
    ...chat,
    chat: { id, name: 'Add dark mode to the pricing page', projectId: 'project-2' },
    subChatId: 'sub-2',
    subChats: [{ id: 'sub-2', name: 'Add dark mode to the pricing page', activity: 'idle' }],
    messages,
  };
}

const logFile = process.env.SIM_RELAY_LOG ?? '/tmp/frink-sim-relay/requests.log';
const READS = new Set([
  'overview',
  'projects',
  'chats',
  'chat',
  'flows',
  'flow',
  'run',
  'composer',
]);
/** The messages sent to the chat this session made. */
const sent: unknown[] = [];

type Composer = { mode: string; settings: Record<string, unknown> };
/** What the Mac would answer: a pairing, a saved composer change, or the fixture for the request. */
type Input = Record<string, string> & { type: string; patch?: object };
const FIXED: Record<string, unknown> = {
  '/pair': {
    token: 'b'.repeat(43),
    deviceId: 'device-1',
    machineName: 'Fixture Mac',
    apiVersion: 3,
  },
  '/api/notifications': { data: { enabled: false, error: null } },
  '/api/attachments': { data: { id: 'att-1', kind: 'file', name: 'file', size: 4 } },
};

/** A composer change is saved and the whole composer comes back, as the bridge does. */
function changeComposer(input: Input) {
  const composer = data.composer as Composer;
  if (input.type === 'updateComposer') composer.settings = { ...composer.settings, ...input.patch };
  if (input.type === 'setMode') composer.mode = String(input.mode);
  if (input.type === 'setAccount') {
    const { accounts } = composer as unknown as { accounts: Array<{ id: string }> };
    const picked = accounts.find((account) => account.id === input.accountId);
    if (picked)
      Object.assign(composer, {
        account: { ...picked, isAuthenticated: true, isProjectOverride: true },
      });
  }
  return composer;
}

const HANDLERS: Record<string, (input: Input) => unknown> = {
  flows: () => macFlows(),
  flow: (input) => flowFor(input.id, Number(input.runLimit ?? 5)),
  run: (input) => runFor(input.id),
  // Run now opens the run it started, so the answer names one.
  startFlow: (input) => ({ id: `run-of-${input.id}` }),
  updateComposer: changeComposer,
  setMode: changeComposer,
  setAccount: changeComposer,
  chat: (input) => chatFor(String(input.id)),
  createChat: () => {
    sent.length = 0;
    return { chatId: 'chat-new', subChatId: 'sub-new' };
  },
  sendMessage: (input) => {
    if (input.chatId === 'chat-new')
      sent.push({
        id: input.requestId,
        role: 'user',
        text: input.text,
        parts: [{ type: 'text', text: input.text }],
      });
    return { ok: true };
  },
};

/** What the Mac would answer: a fixed reply per path, else the handler or fixture for the request. */
function answer(path: string, body: string): unknown {
  // What the phone asked the Mac to change, for checking that nothing is left behind.
  const log = () => appendFileSync(logFile, `${new Date().toISOString()} ${path} ${body}\n`);
  if (path in FIXED) {
    if (path !== '/pair') log();
    return FIXED[path];
  }
  const input = JSON.parse(body) as Input;
  if (!READS.has(input.type)) log();
  const handler = HANDLERS[input.type];
  return { data: handler ? handler(input) : (data[input.type] ?? { ok: true }) };
}

// Bun runs this file; the app's own tsconfig has no Bun types.
declare const Bun: { serve(options: unknown): void; file(path: string): unknown };
type Upgrader = { upgrade(request: Request, options: { data: Peer }): boolean };
type Socket = { data: Peer; send(data: string | Uint8Array): void };
type Peer = {
  encoder: Encoder;
  decoder: Decoder;
  session?: ChannelSession;
  requests: Map<number, { path: string; chunks: number[] }>;
};

Bun.serve({
  // Loopback only: the simulator shares this Mac's network, and nothing else should reach it.
  hostname: '127.0.0.1',
  port,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch(request: Request, server: Upgrader) {
    const peer: Peer = { encoder: new Encoder(), decoder: new Decoder(), requests: new Map() };
    return server.upgrade(request, { data: peer })
      ? undefined
      : new Response('Frink fixture relay');
  },
  websocket: {
    open(socket: Socket) {
      const peer = socket.data;
      const send = (packet: Packet) => {
        for (const chunk of peer.encoder.encode(packet))
          socket.send(typeof chunk === 'string' ? `4${chunk}` : (chunk as Uint8Array));
      };
      const frame = (bytes: Uint8Array) =>
        send({ type: PacketType.EVENT, nsp: '/mobile', data: ['frame', bytes] });
      const respond = (id: number, path: string, body: string) => {
        const bytes = new TextEncoder().encode(JSON.stringify(answer(path, body)));
        for (const [index, part] of envelopeBodyParts(bytes).entries())
          frame(
            peer.session!.seal(
              encodeEnvelope({ t: 'res', id, ...part, ...(index === 0 ? { status: 200 } : {}) }),
            ),
          );
      };
      const handle = (part: MobileEnvelope) => {
        if (part.t === 'cancel') peer.requests.delete(part.id);
        if (part.t !== 'req') return;
        if (part.path) peer.requests.set(part.id, { path: part.path, chunks: [] });
        const request = peer.requests.get(part.id)!;
        request.chunks.push(...fromBase64(part.body));
        if (!part.end) return;
        peer.requests.delete(part.id);
        respond(part.id, request.path, new TextDecoder().decode(new Uint8Array(request.chunks)));
      };
      peer.decoder.on('decoded', (packet: Packet) => {
        if (packet.type === PacketType.CONNECT)
          return send({ type: PacketType.CONNECT, nsp: '/mobile', data: { sid: 'fixture-peer' } });
        if (packet.type !== PacketType.EVENT || packet.data[0] !== 'frame') return;
        const bytes = new Uint8Array(packet.data[1]);
        if (!peer.session) {
          const ready = answerHandshake(bytes, desktop)!;
          peer.session = ready.session;
          frame(ready.ready);
        } else handle(decodeEnvelope(peer.session.open(bytes)!) as MobileEnvelope);
        if (packet.id !== undefined)
          send({ type: PacketType.ACK, nsp: '/mobile', id: packet.id, data: [true] });
      });
      socket.send(
        `0${JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`,
      );
    },
    message(socket: Socket, message: string | Uint8Array) {
      if (typeof message !== 'string') return socket.data.decoder.add(message);
      if (message === '2') socket.send('3');
      else if (message.startsWith('4')) socket.data.decoder.add(message.slice(1));
    },
  },
});

console.log(
  mobilePairingLink({
    version: 3,
    relay: `https://localhost:${port}`,
    route: 'c'.repeat(64),
    key: encodeKey(desktop.publicKey),
    machine: 'Fixture Mac',
    code: 'a'.repeat(43),
  }),
);
