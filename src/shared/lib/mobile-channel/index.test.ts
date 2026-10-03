import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import {
  answerHandshake,
  decodeEnvelope,
  decodeKey,
  encodeEnvelope,
  encodeKey,
  generateDesktopKeyPair,
  MAX_FRAME_BYTES,
  MAX_FRAME_PLAINTEXT_BYTES,
  setChannelRandomSource,
  startHandshake,
} from './index';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

function connect() {
  const desktop = generateDesktopKeyPair();
  const phone = startHandshake(desktop.publicKey);
  const answer = answerHandshake(phone.hello, desktop);
  if (!answer) throw new Error('desktop refused the hello');
  const phoneSession = phone.finish(answer.ready);
  if (!phoneSession) throw new Error('phone refused the ready');
  return { desktop, phone, answer, phoneSession, desktopSession: answer.session };
}

describe('mobile channel handshake', () => {
  it('lets each side read what the other sealed, in both directions', () => {
    const { phoneSession, desktopSession } = connect();
    expect(text(desktopSession.open(phoneSession.seal(bytes('list chats'))))).toBe('list chats');
    expect(text(phoneSession.open(desktopSession.seal(bytes('3 chats'))))).toBe('3 chats');
    expect(text(desktopSession.open(phoneSession.seal(bytes('second'))))).toBe('second');
  });

  it('refuses a desktop whose key is not the one pinned in the QR', () => {
    const real = generateDesktopKeyPair();
    const impostor = generateDesktopKeyPair();
    const phone = startHandshake(real.publicKey);
    const answer = answerHandshake(phone.hello, impostor);
    expect(answer).not.toBeNull();
    expect(phone.finish(answer!.ready)).toBeNull();
  });

  it('finishes once: a duplicated ready mints no second session', () => {
    const desktop = generateDesktopKeyPair();
    const phone = startHandshake(desktop.publicKey);
    const answer = answerHandshake(phone.hello, desktop)!;
    expect(phone.finish(answer.ready)).not.toBeNull();
    expect(phone.finish(answer.ready)).toBeNull();
  });

  it('wipes both ephemeral secrets once the session key exists, on success and on refusal', () => {
    const minted: { secretKey: Uint8Array }[] = [];
    const keyPair = nacl.box.keyPair;
    const spy = vi.spyOn(nacl.box, 'keyPair').mockImplementation(() => {
      const pair = keyPair();
      minted.push(pair);
      return pair;
    });
    try {
      const desktop = { ...keyPair() };
      const phone = startHandshake(desktop.publicKey);
      const answer = answerHandshake(phone.hello, desktop)!;
      expect(phone.finish(answer.ready)).not.toBeNull();
      const refused = startHandshake(desktop.publicKey);
      expect(refused.finish(new Uint8Array(3))).toBeNull();
      expect(minted).toHaveLength(3);
      for (const pair of minted) expect(pair.secretKey.every((byte) => byte === 0)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a random source that returns too few bytes', () => {
    setChannelRandomSource((length) => new Uint8Array(length - 1));
    try {
      expect(() => generateDesktopKeyPair()).toThrow('wrong length');
    } finally {
      setChannelRandomSource((length) => globalThis.crypto.getRandomValues(new Uint8Array(length)));
    }
  });

  it('refuses a ready replayed from an earlier connection', () => {
    const desktop = generateDesktopKeyPair();
    const earlier = answerHandshake(startHandshake(desktop.publicKey).hello, desktop)!;
    expect(startHandshake(desktop.publicKey).finish(earlier.ready)).toBeNull();
  });

  it('refuses a relay that swaps in its own ephemeral key', () => {
    const desktop = generateDesktopKeyPair();
    const phone = startHandshake(desktop.publicKey);
    const answer = answerHandshake(phone.hello, desktop)!;
    const forged = answer.ready.slice();
    forged.set(nacl.box.keyPair().publicKey, 1);
    expect(phone.finish(forged)).toBeNull();
  });

  it('rejects malformed handshake messages', () => {
    const desktop = generateDesktopKeyPair();
    expect(answerHandshake(new Uint8Array(10), desktop)).toBeNull();
    const phone = startHandshake(desktop.publicKey);
    const hello = phone.hello.slice();
    hello[0] = 0x02;
    expect(answerHandshake(hello, desktop)).toBeNull();
    expect(phone.finish(new Uint8Array(5))).toBeNull();
  });
});

describe('mobile channel frames', () => {
  it('keeps the relay from reading or forging a frame', () => {
    const { phoneSession, desktopSession } = connect();
    const frame = phoneSession.seal(bytes('secret token'));
    expect(text(frame)).not.toContain('secret token');
    const tampered = frame.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(desktopSession.open(tampered)).toBeNull();
  });

  it('drops the channel for good on a replayed, reordered or reflected frame', () => {
    const replay = connect();
    const first = replay.phoneSession.seal(bytes('one'));
    expect(text(replay.desktopSession.open(first))).toBe('one');
    expect(replay.desktopSession.open(first)).toBeNull();
    expect(replay.desktopSession.open(replay.phoneSession.seal(bytes('two')))).toBeNull();
    // A broken side sends nothing more either: it must reconnect.
    expect(() => replay.desktopSession.seal(bytes('reply'))).toThrow('Channel closed');

    const reorder = connect();
    reorder.phoneSession.seal(bytes('skipped'));
    expect(reorder.desktopSession.open(reorder.phoneSession.seal(bytes('late')))).toBeNull();

    // A desktop frame bounced back at the desktop must not open: directions use distinct nonces.
    const reflect = connect();
    expect(reflect.desktopSession.open(reflect.desktopSession.seal(bytes('echo')))).toBeNull();
  });

  it('gives each connection its own key', () => {
    const desktop = generateDesktopKeyPair();
    const a = startHandshake(desktop.publicKey);
    const b = startHandshake(desktop.publicKey);
    const answerA = answerHandshake(a.hello, desktop)!;
    const answerB = answerHandshake(b.hello, desktop)!;
    const phoneA = a.finish(answerA.ready)!;
    b.finish(answerB.ready);
    expect(answerB.session.open(phoneA.seal(bytes('for A')))).toBeNull();
  });
});

describe('mobile channel encoding', () => {
  it('round-trips a key through base64url and refuses anything else', () => {
    const { publicKey } = generateDesktopKeyPair();
    const encoded = encodeKey(publicKey);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeKey(encoded)).toEqual(publicKey);
    expect(decodeKey(`${encoded}A`)).toBeNull();
    expect(decodeKey(encoded.replace(/.$/, '/'))).toBeNull();
    expect(decodeKey('')).toBeNull();
  });

  it('round-trips JSON envelopes and returns null for garbage', () => {
    expect(decodeEnvelope(encodeEnvelope({ id: 1, path: '/api' }))).toEqual({
      id: 1,
      path: '/api',
    });
    expect(decodeEnvelope(Uint8Array.of(0xff, 0xfe))).toBeNull();
    expect(decodeEnvelope(bytes('{not json'))).toBeNull();
  });

  it('seals up to the relay frame cap and refuses anything larger', () => {
    const { phoneSession, desktopSession } = connect();
    const big = Uint8Array.from({ length: MAX_FRAME_PLAINTEXT_BYTES }, (_, index) => index % 251);
    const frame = phoneSession.seal(big);
    expect(frame.length).toBe(MAX_FRAME_BYTES);
    expect(() => phoneSession.seal(new Uint8Array(MAX_FRAME_PLAINTEXT_BYTES + 1))).toThrow();
    // The refused seal spent no counter, so the channel carries on in order.
    expect(desktopSession.open(frame)).toEqual(big);
    expect(text(desktopSession.open(phoneSession.seal(bytes('after'))))).toBe('after');
    expect(desktopSession.open(new Uint8Array(MAX_FRAME_BYTES + 1))).toBeNull();
  });

  it('draws randomness from the source the phone installs', () => {
    let calls = 0;
    setChannelRandomSource((length) => {
      calls++;
      return globalThis.crypto.getRandomValues(new Uint8Array(length));
    });
    connect();
    expect(calls).toBeGreaterThan(0);
  });
});
