/**
 * Public webhook and encrypted mobile relay. Forward deliveries or opaque frames to the route
 * holder, then forget them. No durable storage, offline queue, provider secrets or accounts.
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
import { Server as SocketServer, type Socket } from 'socket.io';

const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const FRAME_BYTES = 256 * 1024;
const UNAVAILABLE = 'Mobile connection unavailable.';
const DEFAULT_LIMITS = {
  sockets: 4096,
  socketsPerIp: 128,
  phonesPerRoute: 20,
  attemptsPerMinute: 60,
  framesPerMinute: 2048,
  bytesPerMinute: 64 * 1024 * 1024,
  pendingFrames: 8,
  ackTimeoutMs: 15_000,
  windowMs: 60_000,
};
type MobileRelayLimits = Partial<typeof DEFAULT_LIMITS>;
type Origin = (input: { address: string; headers: IncomingHttpHeaders }) => string;
type Route = { desktop: Socket; phones: Map<string, Socket>; bytes: number };
type Ack = (received: boolean) => void;

/** Fixed-window counters are bounded even if rejected clients churn arbitrary IPs. */
function spend(budget: Map<string, number>, key: string, cap: number, maxKeys: number) {
  if (!budget.has(key) && budget.size >= maxKeys) return false;
  const count = (budget.get(key) ?? 0) + 1;
  budget.set(key, count);
  return count <= cap;
}

function mobileIdentity(socket: Socket) {
  const auth = socket.handshake.auth ?? {};
  if (!['desktop', 'phone'].includes(auth.role)) return null;
  const host = auth.role === 'desktop';
  const key = host ? auth.key : auth.route;
  if (typeof key !== 'string' || !HEX_32_BYTES.test(key)) return null;
  return { host, id: host ? createHash('sha256').update(key, 'utf8').digest('hex') : key };
}

function reserveRoute(
  socket: Socket,
  routes: Map<string, Route>,
  id: string,
  host: boolean,
  cap: number,
) {
  let route = routes.get(id);
  if (host) {
    // A matching preimage proves ownership; replace a stale connection after network changes.
    route?.desktop.disconnect(true);
    route = { desktop: socket, phones: new Map(), bytes: 0 };
    routes.set(id, route);
  } else {
    if (!route || !route.desktop.connected || route.phones.size >= cap) return null;
    route.phones.set(socket.id, socket);
  }
  return route;
}

function frameDestination(frame: unknown, socket: Socket, route: Route) {
  if (route.desktop !== socket) return { phone: socket, target: route.desktop, data: frame };
  if (!frame || typeof frame !== 'object') return null;
  const { peerId, data } = frame as Record<string, unknown>;
  if (typeof peerId !== 'string') return null;
  const phone = route.phones.get(peerId);
  return phone ? { phone, target: phone, data } : null;
}

function mobileFrame(frame: unknown, socket: Socket, route: Route) {
  const decoded = frameDestination(frame, socket, route);
  if (!decoded || !decoded.target.connected) return null;
  const { phone, target, data } = decoded;
  if (!(data instanceof Uint8Array)) return null;
  if (!data.byteLength || data.byteLength > FRAME_BYTES) return null;
  return { phone, target, data };
}

function attachMobileRelay(io: SocketServer, origin: Origin, options: MobileRelayLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const mobile = io.of('/mobile');
  const routes = new Map<string, Route>();
  const byIp = new Map<string, number>();
  const reservations = new WeakMap<IncomingMessage, () => void>();
  let sockets = 0;
  const upgrades = new Map<string, number>();
  const attempts = new Map<string, number>();
  const frames = new Map<string, number>();
  const pending = new Map<string, number>();
  const keyCap = limits.sockets * 2;
  const ipFor = (input: Parameters<Origin>[0]) => ipKeyGenerator(origin(input));
  const reset = setInterval(() => {
    upgrades.clear();
    attempts.clear();
    frames.clear();
    for (const route of routes.values()) route.bytes = 0;
  }, limits.windowMs);
  reset.unref();

  // Bound raw Engine.IO sockets too: an unauthenticated client need never join a namespace.
  io.engine.use(
    (
      request: IncomingMessage & { _query: Record<string, unknown> },
      _response: unknown,
      next: (error?: Error) => void,
    ) => {
      if (request._query.sid) return next();
      const ip = ipFor({ address: request.socket.remoteAddress ?? '', headers: request.headers });
      if (
        sockets >= limits.sockets ||
        (byIp.get(ip) ?? 0) >= limits.socketsPerIp ||
        !spend(upgrades, ip, limits.attemptsPerMinute, keyCap)
      ) {
        return next(new Error(UNAVAILABLE));
      }
      // Engine.IO awaits generateId after middleware: count pending and established sockets alike.
      sockets++;
      byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
      const release = () => {
        if (!reservations.delete(request)) return;
        request.socket.off('close', release);
        sockets--;
        const count = (byIp.get(ip) ?? 1) - 1;
        if (count) byIp.set(ip, count);
        else byIp.delete(ip);
      };
      reservations.set(request, release);
      request.socket.once('close', release);
      next();
    },
  );
  io.engine.on('connection', (connection) => {
    const release = reservations.get(connection.request);
    if (!release) return connection.close(true);
    // Polling may outlive its initial TCP connection; the Engine.IO socket now owns the reservation.
    connection.request.socket.off('close', release);
    connection.once('close', release);
  });
  io.engine.on('connection_error', ({ req }) => reservations.get(req)?.());

  mobile.use((socket, next) => {
    // Native iOS/Android add Origin too. This marker is browser abuse friction, never auth.
    const headers = socket.handshake.headers;
    if (headers.origin && headers['x-frink-mobile'] !== '1') return next(new Error(UNAVAILABLE));
    if (socket.conn.transport.name !== 'websocket') return next(new Error(UNAVAILABLE));
    if (!spend(attempts, ipFor(socket.handshake), limits.attemptsPerMinute, keyCap)) {
      return next(new Error(UNAVAILABLE));
    }
    const identity = mobileIdentity(socket);
    if (!identity) return next(new Error(UNAVAILABLE));
    const { id, host } = identity;
    const route = reserveRoute(socket, routes, id, host, limits.phonesPerRoute);
    if (!route) return next(new Error(UNAVAILABLE));
    socket.data.mobileRoute = route;
    // Reserve in middleware to prevent simultaneous hosts/phones racing the admission limits.
    const release = () => {
      if (host && routes.get(id)?.desktop === socket) {
        routes.delete(id);
        for (const phone of route.phones.values()) phone.disconnect(true);
      } else if (!host && route.phones.delete(socket.id)) {
        route.desktop.emit('peer-disconnected', socket.id);
      }
      frames.delete(socket.id);
      pending.delete(socket.id);
    };
    socket.once('disconnect', release);
    socket.conn.once('close', release);
    next();
  });

  mobile.on('connection', (socket) => {
    const route: Route = socket.data.mobileRoute;
    const host = route.desktop === socket;
    if (!host) route.desktop.emit('peer-connected', socket.id);
    socket.on('disconnect-peer', (peerId: unknown) => {
      if (host && typeof peerId === 'string') route.phones.get(peerId)?.disconnect(true);
    });
    socket.on('frame', (frame: unknown, acknowledge: unknown) => {
      const decoded = mobileFrame(frame, socket, route);
      if (!decoded || typeof acknowledge !== 'function') {
        socket.disconnect(true);
        return;
      }
      const { phone, target, data } = decoded;
      if (
        (pending.get(phone.id) ?? 0) >= limits.pendingFrames ||
        !spend(frames, socket.id, limits.framesPerMinute, keyCap) ||
        (route.bytes += data.byteLength) > limits.bytesPerMinute
      ) {
        socket.disconnect(true);
        return;
      }
      pending.set(phone.id, (pending.get(phone.id) ?? 0) + 1);
      const payload = host ? data : { peerId: phone.id, data };
      target.timeout(limits.ackTimeoutMs).emit('frame', payload, (error: Error | null) => {
        if (phone.connected) pending.set(phone.id, Math.max(0, (pending.get(phone.id) ?? 1) - 1));
        if (error) phone.disconnect(true);
        else if (socket.connected) (acknowledge as Ack)(true);
      });
    });
  });
  return () => clearInterval(reset);
}

const BODY_MAX_BYTES = 1_048_576;
const WINDOW_MS = 60_000;
const POSTS_PER_TOKEN = 60;
const SUBSCRIBES_PER_IP = 20;
const SUBSCRIBES_PER_SOCKET = 20;
const TRUSTED_PROXY_HOPS = 1;
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
  options: { subscribesPerSocket?: number; windowMs?: number; mobile?: MobileRelayLimits } = {},
): Relay {
  const proxyHops = trustedProxyHops();
  const windowMs = options.windowMs ?? WINDOW_MS;
  const app = express();
  // Nothing on the HTTP side reads req.ip; the same hop count here only keeps express-rate-limit's
  // forwarded-header validation quiet.
  app.set('trust proxy', proxyHops);
  app.use(helmet());

  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { maxHttpBufferSize: FRAME_BYTES });
  const stopMobile = attachMobileRelay(
    io,
    (handshake) => originOf(handshake, proxyHops),
    options.mobile,
  );

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
        stopMobile();
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
