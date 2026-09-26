/**
 * The public webhook relay: forward the exact bytes of an inbound delivery to whoever holds the
 * subscribe key for that path token, then forget it. No storage, no retry, no secrets, no accounts.
 */

import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import express, { type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';

const BODY_MAX_BYTES = 1_048_576;
const WINDOW_MS = 60_000;
const POSTS_PER_TOKEN = 60;
const SUBSCRIBES_PER_IP = 20;
const SUBSCRIBES_PER_SOCKET = 20;
const TRUSTED_PROXY_HOPS = 1;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const DEFAULT_PORT = 8787;

type DeliveryParams = { provider: string; token: string };

type SubscribeLimits = { perSocket: number; proxyHops: number };

export type Relay = {
  httpServer: HttpServer;
  io: SocketServer;
  close: () => Promise<void>;
};

type BodyRead = { kind: 'body'; body: Buffer } | { kind: 'too_large' } | { kind: 'aborted' };

// Reason: the relay is standalone by design and must never import the app
// fallow-ignore-next-line code-duplication
function readCappedBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    req.on('data', (chunk: Buffer) => {
      // Past the cap, read on and discard: parking wedges the sender's connection, destroying loses the 413.
      if (overCap) return;
      total += chunk.length;
      if (total > BODY_MAX_BYTES) {
        overCap = true;
        resolve({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ kind: 'body', body: Buffer.concat(chunks) }));
    // A sender that hangs up mid-body never emits 'end'; 'close' with an incomplete request is that case.
    req.on('close', () => {
      if (!req.complete) resolve({ kind: 'aborted' });
    });
    req.on('error', reject);
  });
}

// How many proxies of our own stand in front. Railway contributes exactly one; a CDN or a second
// tunnel in front of it adds more. Too high and a sender can claim any address by sending its own header.
function trustedProxyHops(): number {
  const configured = process.env.RELAY_TRUSTED_PROXY_HOPS;
  if (!configured) return TRUSTED_PROXY_HOPS;
  if (!/^\d+$/.test(configured)) {
    throw new Error('RELAY_TRUSTED_PROXY_HOPS must be a non-negative integer');
  }
  return Number(configured);
}

// Socket.IO reports the raw TCP peer, which behind a proxy is the proxy. Stepping `hops` entries
// leftwards through x-forwarded-for is the one thing that decides who a subscribe is counted against.
function originOf(
  handshake: { address: string; headers: IncomingHttpHeaders },
  hops: number,
): string {
  const forwarded = handshake.headers['x-forwarded-for'];
  const claimed = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
    .reverse();
  const chain = [handshake.address, ...claimed];
  return chain[Math.min(hops, chain.length - 1)];
}

function overWindowLimit(hits: Map<string, number>, key: string, limit: number): boolean {
  const used = (hits.get(key) ?? 0) + 1;
  hits.set(key, used);
  return used > limit;
}

async function forwardDelivery(
  io: SocketServer,
  req: Request<DeliveryParams>,
  res: Response,
): Promise<void> {
  let read: BodyRead;
  try {
    read = await readCappedBody(req);
  } catch {
    // A broken stream is the sender's problem; nothing was forwarded and nothing must escape the handler.
    if (!res.headersSent) res.status(400).end();
    return;
  }
  if (read.kind === 'aborted') return;
  if (read.kind === 'too_large') {
    res.status(413).json({ status: 'too_large' });
    return;
  }
  const { provider, token } = req.params;
  if (HEX_32_BYTES.test(token)) {
    if (!io.sockets.adapter.rooms.has(token)) {
      console.warn('[Relay] inbound delivery dropped: nobody subscribed');
    }
    io.to(token).emit('inbound', {
      t: token,
      provider,
      headers: req.headers,
      bodyB64: read.body.toString('base64'),
      receivedAt: new Date().toISOString(),
    });
  }
  res.status(202).json({ status: 'accepted' });
}

function attachSubscribe(
  io: SocketServer,
  hits: { byIp: Map<string, number>; bySocket: Map<string, number> },
  limits: SubscribeLimits,
): void {
  io.on('connection', (socket) => {
    socket.on('subscribe', (payload: { key?: unknown } | undefined) => {
      // The socket's own window is spent first, so over-cap frames never reach the shared address
      // budget. Both caps are 20/min in production: this isolates the socket cap, not neighbours.
      if (overWindowLimit(hits.bySocket, socket.id, limits.perSocket)) return;
      const origin = originOf(socket.handshake, limits.proxyHops);
      if (overWindowLimit(hits.byIp, ipKeyGenerator(origin), SUBSCRIBES_PER_IP)) return;
      const key = String(payload?.key ?? '');
      if (!HEX_32_BYTES.test(key)) return;
      socket.join(createHash('sha256').update(key, 'utf8').digest('hex'));
    });
    socket.on('disconnect', () => hits.bySocket.delete(socket.id));
  });
}

// The cap and the window are injectable so a test can tell this cap apart from the equal-sized
// per-IP budget, and watch a window turn over without waiting a minute. Production passes nothing.
export function createRelay(
  options: { subscribesPerSocket?: number; windowMs?: number } = {},
): Relay {
  const proxyHops = trustedProxyHops();
  const windowMs = options.windowMs ?? WINDOW_MS;
  const app = express();
  // Nothing on the HTTP side reads req.ip; the same hop count here only keeps express-rate-limit's
  // forwarded-header validation quiet.
  app.set('trust proxy', proxyHops);
  app.use(helmet());

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer);

  const subscribesByIp = new Map<string, number>();
  const subscribesBySocket = new Map<string, number>();
  const windowReset = setInterval(() => {
    subscribesByIp.clear();
    subscribesBySocket.clear();
  }, windowMs);
  windowReset.unref();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post<DeliveryParams>(
    '/api/triggers/:provider/:token',
    rateLimit({
      windowMs,
      limit: POSTS_PER_TOKEN,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.params.token),
      message: { status: 'rate_limited' },
    }),
    (req, res) => forwardDelivery(io, req, res),
  );

  attachSubscribe(
    io,
    { byIp: subscribesByIp, bySocket: subscribesBySocket },
    { perSocket: options.subscribesPerSocket ?? SUBSCRIBES_PER_SOCKET, proxyHops },
  );

  return {
    httpServer,
    io,
    close: () =>
      new Promise((resolve) => {
        clearInterval(windowReset);
        io.close(() => resolve());
      }),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createRelay().httpServer.listen(port, () => {
    console.log(`[Relay] listening on ${port}`);
  });
}
