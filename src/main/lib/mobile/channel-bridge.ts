import { randomUUID } from 'node:crypto';
import {
  envelopeBodyParts,
  fromBase64,
  type MobileEnvelope,
} from '../../../shared/types/remote/mobile-envelope';
import { MOBILE_CHANNEL_HEADER, MOBILE_UPLOAD_MAX_BYTES } from './server';
import type { MobileStreamHub } from './stream';

/** Requests one phone may have open at once over a channel; the phone's polling needs a handful.
 * Cancelled requests the app still runs get a separate cap of the same size. */
const MAX_IN_FLIGHT = 8;
/** Far past any phone's own timeout: a channel whose live or cancelled slots are all this old is hung. */
const STUCK_MS = 5 * 60_000;
const JSON_BODY_MAX_BYTES = 128 * 1024;
const ATTACHMENTS_PATH = '/api/attachments';
const PAIR_PATH = '/pair';
/** Requests are built against this origin; nothing resolves it, Hono only reads the path. */
const CHANNEL_ORIGIN = 'https://frink-mobile.invalid';
const encoder = new TextEncoder();

type RequestPart = Extract<MobileEnvelope, { t: 'req' }>;
type Assembly = {
  path: string;
  headers: Record<string, string>;
  chunks: Uint8Array[];
  size: number;
  limit: number;
};

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function pairedToken(bytes: Uint8Array): string | null {
  try {
    const token: unknown = JSON.parse(new TextDecoder().decode(bytes)).token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

function joined(assembly: Assembly): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(assembly.size);
  let offset = 0;
  for (const chunk of assembly.chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Request bytes every channel together may hold before the app runs them; the relay is untrusted. */
export type BodyBudget = { take(bytes: number): boolean; give(bytes: number): void };

export function createBodyBudget(maxBytes: number): BodyBudget {
  let used = 0;
  return {
    take(bytes) {
      if (used + bytes > maxBytes) return false;
      used += bytes;
      return true;
    },
    give(bytes) {
      used = Math.max(0, used - bytes);
    },
  };
}

type BridgeOptions = {
  fetch: (request: Request) => Response | Promise<Response>;
  /** Settles once the relay has taken the frame. */
  send: (envelope: MobileEnvelope) => Promise<void>;
  /** A protocol violation; the caller drops the channel. */
  fail: () => void;
  /** Checked before any body is buffered, so only a paired phone can make this desktop hold bytes. */
  authenticate: (token: string) => boolean;
  budget: BodyBudget;
  /** Where this channel's live chat watches are kept, from open to close. */
  streams: Pick<MobileStreamHub, 'register' | 'unregister'>;
};

export type ChannelBridge = {
  receive(envelope: MobileEnvelope): void;
  /** Every bearer token this channel was issued or presented, so a revocation can find it. */
  tokens(): ReadonlySet<string>;
  close(): void;
};

/** Turns envelope parts from one decrypted channel into requests against the mobile Hono app, and
 * its responses back into parts. */
class Bridge implements ChannelBridge {
  private readonly assembling = new Map<number, Assembly>();
  /** Requests the app is running, with when each started. */
  private readonly running = new Map<number, number>();
  /** Running requests the phone cancelled: their ids stay taken until the app answers, unsent. */
  private readonly cancelled = new Set<number>();
  /** Refused requests whose remaining parts are still to be swallowed. */
  private readonly refused = new Set<number>();
  private readonly seen = new Set<string>();
  private closed = false;
  private readonly channelId = randomUUID();

  constructor(private readonly options: BridgeOptions) {
    // Sealed in call order, so an event queues behind responses already sent.
    options.streams.register(this.channelId, (envelope) =>
      this.closed ? Promise.resolve() : options.send(envelope),
    );
  }

  receive(envelope: MobileEnvelope): void {
    if (this.closed) return;
    if (envelope.t === 'res' || envelope.t === 'evt') return this.options.fail();
    if (envelope.t === 'cancel') {
      this.release(envelope.id);
      this.refused.delete(envelope.id);
      if (this.running.has(envelope.id)) this.cancelled.add(envelope.id);
      return;
    }
    if (this.refused.has(envelope.id)) {
      if (envelope.end) this.refused.delete(envelope.id);
      return;
    }
    const assembly = this.assembling.get(envelope.id) ?? this.begin(envelope);
    if (assembly) this.append(envelope, assembly);
  }

  tokens(): ReadonlySet<string> {
    return this.seen;
  }

  close(): void {
    this.closed = true;
    this.options.streams.unregister(this.channelId);
    for (const id of [...this.assembling.keys()]) this.release(id);
    this.running.clear();
    this.cancelled.clear();
  }

  /** Whether `id` is new, and refused requests still being swallowed stay bounded. */
  private admits(id: number): boolean {
    if (this.running.has(id) || this.refused.has(id)) return false;
    return this.refused.size < MAX_IN_FLIGHT;
  }

  /** Whether requests the app started by `before`, plus `assembling` unfinished ones, fill the live
   * or the cancelled cap. Refused ids hold no body or app work, and `admits` bounds them. */
  private full(before: number, assembling: number): boolean {
    let live = assembling;
    let cancelled = 0;
    for (const [id, started] of this.running) {
      if (started > before) continue;
      if (this.cancelled.has(id)) cancelled++;
      else live++;
    }
    return live >= MAX_IN_FLIGHT || cancelled >= MAX_IN_FLIGHT;
  }

  /** Whether the request may make this desktop hold a body; remembers a token that authenticates,
   * so at most one per paired phone is kept. */
  private authorized(path: string, headers: Record<string, string>): boolean {
    const token = /^Bearer (\S+)$/i.exec(headerValue(headers, 'authorization') ?? '')?.[1];
    const valid = token !== undefined && this.options.authenticate(token);
    if (valid) this.seen.add(token);
    return path === PAIR_PATH || valid;
  }

  /** The first part of a request: its path and headers, checked before any body is held. */
  private begin(envelope: RequestPart): Assembly | null {
    const { id, path, headers } = envelope;
    // A broken or hostile client: phones always open with a path and a new id.
    if (!path || !headers || !this.admits(id)) {
      this.options.fail();
      return null;
    }
    const now = Date.now();
    // Requests the app never answers would refuse this phone for good; a fresh channel recovers.
    if (this.full(now - STUCK_MS, 0)) {
      this.options.fail();
      return null;
    }
    if (this.full(now, this.assembling.size)) {
      this.refuse(envelope, 429, 'Too many requests. Try again in a moment.');
      return null;
    }
    if (!this.authorized(path, headers)) {
      this.refuse(envelope, 401, 'Access expired or was revoked. Pair this device again.');
      return null;
    }
    const limit = path === ATTACHMENTS_PATH ? MOBILE_UPLOAD_MAX_BYTES : JSON_BODY_MAX_BYTES;
    const assembly = { path, headers, chunks: [], size: 0, limit };
    this.assembling.set(id, assembly);
    return assembly;
  }

  private append(envelope: RequestPart, assembly: Assembly): void {
    const chunk = fromBase64(envelope.body);
    if (assembly.size + chunk.length > assembly.limit) {
      return this.refuse(envelope, 413, 'Request is too large.');
    }
    if (!this.options.budget.take(chunk.length)) {
      return this.refuse(
        envelope,
        503,
        'Your computer is busy with other uploads. Try again shortly.',
      );
    }
    assembly.size += chunk.length;
    assembly.chunks.push(chunk);
    if (!envelope.end) return;
    this.assembling.delete(envelope.id);
    void this.run(envelope.id, assembly);
  }

  /** Gives back what an unfinished request holds. */
  private release(id: number): void {
    const assembly = this.assembling.get(id);
    if (assembly) this.options.budget.give(assembly.size);
    this.assembling.delete(id);
  }

  /** Answers a request now and swallows the rest of its parts, so nothing more of it is held. */
  private refuse(envelope: { id: number; end: boolean }, status: number, error: string): void {
    this.release(envelope.id);
    if (!envelope.end) this.refused.add(envelope.id);
    this.running.set(envelope.id, Date.now());
    this.respond(envelope.id, status, encoder.encode(JSON.stringify({ error })));
  }

  private async run(id: number, assembly: Assembly): Promise<void> {
    this.running.set(id, Date.now());
    try {
      // Only the bridge names the channel; a phone's own claim to one is dropped.
      const headers = Object.fromEntries(
        Object.entries(assembly.headers).filter(
          ([key]) => key.toLowerCase() !== MOBILE_CHANNEL_HEADER,
        ),
      );
      headers[MOBILE_CHANNEL_HEADER] = this.channelId;
      const response = await this.options.fetch(
        new Request(`${CHANNEL_ORIGIN}${assembly.path}`, {
          method: 'POST',
          headers,
          body: joined(assembly),
        }),
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      // A phone that just paired is revocable from this moment, not from its first API call.
      const paired = assembly.path === PAIR_PATH && response.ok ? pairedToken(bytes) : null;
      if (paired) this.seen.add(paired);
      this.respond(id, response.status, bytes);
    } catch {
      const error = 'Frink could not complete this request.';
      this.respond(id, 500, encoder.encode(JSON.stringify({ error })));
    } finally {
      // The request's share of the budget ends once the app has answered it.
      this.options.budget.give(assembly.size);
    }
  }

  private respond(id: number, status: number, bytes: Uint8Array): void {
    const cancelled = this.cancelled.delete(id);
    if (!this.running.delete(id) || cancelled || this.closed) return;
    envelopeBodyParts(bytes).forEach((part, index) =>
      this.options.send({ t: 'res', id, ...(index === 0 ? { status } : {}), ...part }),
    );
  }
}

export function createChannelBridge(options: BridgeOptions): ChannelBridge {
  return new Bridge(options);
}
