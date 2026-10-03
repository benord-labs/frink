// Phone↔desktop channel through the untrusted relay: tweetnacl only, desktop key pinned by the QR,
// ephemeral-ephemeral session key. Phone auth stays the bearer token, sent inside the channel.
import nacl from 'tweetnacl';

const KEY_BYTES = nacl.box.publicKeyLength;
const NONCE_BYTES = nacl.box.nonceLength;
const HELLO = 0x01;
const READY = 0x02;
const HELLO_BYTES = 1 + KEY_BYTES;
const READY_BYTES = 1 + KEY_BYTES + NONCE_BYTES + 2 * KEY_BYTES + nacl.box.overheadLength;
/** The relay's per-frame cap; a sealed frame adds secretbox's 16-byte tag to its plaintext. */
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_FRAME_PLAINTEXT_BYTES = MAX_FRAME_BYTES - nacl.secretbox.overheadLength;

export type ChannelKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
type Direction = 'phone-to-desktop' | 'desktop-to-phone';

/** Hermes has no crypto.getRandomValues; the phone hands in expo-crypto's generator once at startup. */
export function setChannelRandomSource(randomBytes: (length: number) => Uint8Array): void {
  nacl.setPRNG((target, length) => {
    const bytes = randomBytes(length);
    // A short read would leave the rest of a key or nonce zeroed, which is predictable.
    if (bytes.length !== length) throw new Error('The random source returned the wrong length.');
    target.set(bytes);
  });
}

export function generateDesktopKeyPair(): ChannelKeyPair {
  return nacl.box.keyPair();
}

export function encodeKey(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error('A channel key is 32 bytes.');
  return btoa(String.fromCharCode(...key))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Null for anything that is not exactly a 32-byte base64url key. */
export function decodeKey(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const key = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return encodeKey(key) === text ? key : null;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/** Nonce = direction byte, 15 zero bytes, 8-byte big-endian counter: never reused within a session key. */
function frameNonce(direction: Direction, counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = direction === 'phone-to-desktop' ? 0 : 1;
  // Two 32-bit halves rather than setBigUint64, which not every Hermes release has.
  const view = new DataView(nonce.buffer);
  view.setUint32(16, Math.floor(counter / 2 ** 32));
  view.setUint32(20, counter >>> 0);
  return nonce;
}

/**
 * One connection's keys. Frames must arrive in order and exactly once: the relay is a single
 * in-order stream, so a gap, replay or reorder means tampering and `open` returns null for good.
 */
export class ChannelSession {
  private sent = 0;
  private received = 0;
  private broken = false;

  constructor(
    private readonly key: Uint8Array,
    private readonly outbound: Direction,
    private readonly inbound: Direction,
  ) {}

  seal(plaintext: Uint8Array): Uint8Array {
    if (this.broken) throw new Error('Channel closed; reconnect.');
    if (plaintext.length > MAX_FRAME_PLAINTEXT_BYTES) throw new Error('Frame too large; chunk it.');
    if (this.sent >= Number.MAX_SAFE_INTEGER) throw new Error('Channel exhausted; reconnect.');
    return nacl.secretbox(plaintext, frameNonce(this.outbound, this.sent++), this.key);
  }

  open(frame: Uint8Array): Uint8Array | null {
    if (this.broken || frame.length > MAX_FRAME_BYTES) {
      this.broken = true;
      return null;
    }
    const plaintext = nacl.secretbox.open(frame, frameNonce(this.inbound, this.received), this.key);
    if (!plaintext) {
      this.broken = true;
      return null;
    }
    this.received++;
    return plaintext;
  }
}

/** Phone side: send `hello`, then pass the desktop's reply to `finish`. Null means not our desktop. */
export function startHandshake(desktopPublicKey: Uint8Array): {
  hello: Uint8Array;
  finish: (ready: Uint8Array) => ChannelSession | null;
} {
  if (desktopPublicKey.length !== KEY_BYTES) throw new Error('A channel key is 32 bytes.');
  const ephemeral = nacl.box.keyPair();
  let finished = false;
  return {
    hello: concat(Uint8Array.of(HELLO), ephemeral.publicKey),
    // One-shot: a duplicated ready must not mint a second session that restarts the counters.
    finish(ready) {
      if (finished) return null;
      finished = true;
      try {
        if (ready.length !== READY_BYTES || ready[0] !== READY) return null;
        const desktopEphemeral = ready.subarray(1, 1 + KEY_BYTES);
        const nonce = ready.subarray(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES);
        const proof = nacl.box.open(
          ready.subarray(1 + KEY_BYTES + NONCE_BYTES),
          nonce,
          desktopPublicKey,
          ephemeral.secretKey,
        );
        if (!proof || !equalBytes(proof, concat(desktopEphemeral, ephemeral.publicKey)))
          return null;
        const key = nacl.box.before(desktopEphemeral, ephemeral.secretKey);
        return new ChannelSession(key, 'phone-to-desktop', 'desktop-to-phone');
      } finally {
        // Forward secrecy: once the session key exists, nothing may be able to rederive it.
        ephemeral.secretKey.fill(0);
      }
    },
  };
}

/** Desktop side: answer a phone's hello. Null for a malformed hello. */
export function answerHandshake(
  hello: Uint8Array,
  desktop: ChannelKeyPair,
): { ready: Uint8Array; session: ChannelSession } | null {
  if (hello.length !== HELLO_BYTES || hello[0] !== HELLO) return null;
  const phoneEphemeral = hello.slice(1);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(NONCE_BYTES);
  const proof = nacl.box(
    concat(ephemeral.publicKey, phoneEphemeral),
    nonce,
    phoneEphemeral,
    desktop.secretKey,
  );
  const key = nacl.box.before(phoneEphemeral, ephemeral.secretKey);
  ephemeral.secretKey.fill(0);
  return {
    ready: concat(Uint8Array.of(READY), ephemeral.publicKey, nonce, proof),
    session: new ChannelSession(key, 'desktop-to-phone', 'phone-to-desktop'),
  };
}

export function encodeEnvelope(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Null for bytes that are not UTF-8 JSON; callers validate the shape with their own schema. */
export function decodeEnvelope(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}
