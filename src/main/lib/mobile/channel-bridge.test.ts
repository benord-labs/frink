import { describe, expect, it, vi } from 'vitest';
vi.mock('../sentry', () => ({ captureContained: vi.fn() }));
import {
  envelopeBodyParts,
  fromBase64,
  MOBILE_ENVELOPE_PART_BYTES,
  type MobileEnvelope,
} from '../../../shared/types/remote/mobile-envelope';
import { createBodyBudget, createChannelBridge } from './channel-bridge';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function harness(fetch = vi.fn(async (request: Request) => Response.json({ echo: request.url }))) {
  const sent: MobileEnvelope[] = [];
  const fail = vi.fn();
  const budget = createBodyBudget(MOBILE_ENVELOPE_PART_BYTES * 4);
  const bridge = createChannelBridge({
    fetch,
    send: (envelope) => sent.push(envelope),
    fail,
    authenticate: (token) => token !== 'revoked',
    budget,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const response = (id: number) => {
    const parts = sent.filter((part) => part.t === 'res' && part.id === id);
    const bytes = parts.flatMap((part) => [...fromBase64((part as { body: string }).body)]);
    return {
      status: (parts[0] as { status?: number } | undefined)?.status,
      json: JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))),
      ended: parts.at(-1)?.t === 'res' && (parts.at(-1) as { end: boolean }).end,
    };
  };
  return { bridge, fetch, sent, fail, settle, response, budget };
}

function request(
  id: number,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = { Authorization: 'Bearer ok' },
): MobileEnvelope[] {
  return envelopeBodyParts(body).map((part, index) => ({
    t: 'req',
    id,
    ...(index === 0 ? { path: path as '/api', headers } : {}),
    ...part,
  }));
}

describe('mobile channel bridge', () => {
  it('runs a request through the app and returns its exact status and body', async () => {
    const fetch = vi.fn(async (incoming: Request) => {
      expect(new URL(incoming.url).pathname).toBe('/api');
      expect(incoming.headers.get('authorization')).toBe('Bearer abc');
      return Response.json({ data: await incoming.json() }, { status: 201 });
    });
    const { bridge, settle, response } = harness(fetch);
    for (const part of request(1, '/api', encode({ type: 'overview' }), {
      Authorization: 'Bearer abc',
    }))
      bridge.receive(part);
    await settle();
    expect(response(1)).toEqual({ status: 201, json: { data: { type: 'overview' } }, ended: true });
    expect([...bridge.tokens()]).toEqual(['abc']);
  });

  it('reassembles multi-part uploads and splits large responses', async () => {
    const big = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 2 + 5).fill(7);
    const fetch = vi.fn(async (incoming: Request) => {
      const length = (await incoming.arrayBuffer()).byteLength;
      return Response.json({ length, pad: 'x'.repeat(MOBILE_ENVELOPE_PART_BYTES) });
    });
    const { bridge, sent, settle, response } = harness(fetch);
    const parts = request(2, '/api/attachments', big);
    expect(parts).toHaveLength(3);
    for (const part of parts) bridge.receive(part);
    await settle();
    expect(response(2).json.length).toBe(big.length);
    expect(sent.filter((part) => part.t === 'res').length).toBeGreaterThan(1);
  });

  it('answers oversized JSON with 413 without calling the app', async () => {
    const { bridge, fetch, settle, response, fail } = harness();
    const body = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES + 1);
    for (const part of request(3, '/api', body)) bridge.receive(part);
    await settle();
    expect(response(3).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('fails a channel that opens more requests than a phone ever keeps in flight', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const { bridge, fail } = harness(fetch);
    for (let id = 0; id < 8; id++)
      for (const part of request(id, '/api', encode({}))) bridge.receive(part);
    expect(fail).not.toHaveBeenCalled();
    for (const part of request(8, '/api', encode({}))) bridge.receive(part);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('bounds unfinished oversized uploads instead of remembering every id', () => {
    const { bridge, fail, response } = harness();
    const oversized = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 2 + 1);
    for (let id = 0; id < 8; id++) {
      // Only the first two parts: over the JSON cap, never ended.
      for (const part of request(id, '/api', oversized).slice(0, 2)) bridge.receive(part);
      expect(response(id).status).toBe(413);
    }
    expect(fail).not.toHaveBeenCalled();
    bridge.receive(request(8, '/api', oversized)[0]);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('remembers every token a channel paired with or presented, whatever its header case', async () => {
    const fetch = vi.fn(async (incoming: Request) =>
      new URL(incoming.url).pathname === '/pair'
        ? Response.json({ token: 'fresh', deviceId: 'd' })
        : Response.json({ data: null }),
    );
    const { bridge, settle } = harness(fetch);
    for (const part of request(1, '/pair', encode({ code: 'c', name: 'n' }), {}))
      bridge.receive(part);
    await settle();
    expect([...bridge.tokens()]).toEqual(['fresh']);
    for (const part of request(2, '/api', encode({}), { authorization: 'bearer other' }))
      bridge.receive(part);
    // A refused token is never remembered, so garbage tokens cannot grow the set.
    for (const part of request(3, '/api', encode({}), { Authorization: 'Bearer revoked' }))
      bridge.receive(part);
    expect([...bridge.tokens()]).toEqual(['fresh', 'other']);
  });

  it('fails the channel on parts that break the framing', () => {
    const { bridge, fail } = harness();
    bridge.receive({ t: 'req', id: 9, body: '', end: true });
    bridge.receive({ t: 'res', id: 1, status: 200, body: '', end: true });
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it('keeps a cancelled running id taken until the app answers, and never answers it', async () => {
    let finish: () => void = () => {};
    const fetch = vi.fn(
      () => new Promise<Response>((resolve) => (finish = () => resolve(Response.json({})))),
    );
    const { bridge, sent, fail, settle } = harness(fetch);
    for (const part of request(7, '/api', encode({}))) bridge.receive(part);
    bridge.receive({ t: 'cancel', id: 7 });
    // Reusing the id while the old request still runs is a protocol violation, not a new request.
    for (const part of request(7, '/api', encode({}))) bridge.receive(part);
    expect(fail).toHaveBeenCalled();
    finish();
    await settle();
    expect(sent).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("frees a refused upload's slot when the phone cancels it", () => {
    const { bridge, fail } = harness();
    const oversized = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 2 + 1);
    for (let id = 0; id < 12; id++) {
      for (const part of request(id, '/api', oversized).slice(0, 2)) bridge.receive(part);
      bridge.receive({ t: 'cancel', id });
    }
    expect(fail).not.toHaveBeenCalled();
  });

  it('sends nothing once closed or cancelled', async () => {
    const { bridge, sent, settle } = harness();
    for (const part of request(4, '/api', encode({}))) bridge.receive(part);
    bridge.receive({ t: 'cancel', id: 4 });
    for (const part of request(5, '/api', encode({}))) bridge.receive(part);
    bridge.close();
    await settle();
    expect(sent).toEqual([]);
  });

  it('refuses an unpaired or revoked upload before holding any of its bytes', async () => {
    const { bridge, fetch, response, budget, settle } = harness();
    const big = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 3);
    for (const part of request(1, '/api/attachments', big, {})) bridge.receive(part);
    for (const part of request(2, '/api/attachments', big, { Authorization: 'Bearer revoked' }))
      bridge.receive(part);
    await settle();
    expect(response(1).status).toBe(401);
    expect(response(2).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    // Nothing was reserved, so the whole budget is still free.
    expect(budget.take(MOBILE_ENVELOPE_PART_BYTES * 4)).toBe(true);
  });

  it('shares one body budget across uploads and returns it when they finish', async () => {
    const { bridge, response, budget, settle } = harness();
    const big = new Uint8Array(MOBILE_ENVELOPE_PART_BYTES * 3);
    const first = request(1, '/api/attachments', big);
    bridge.receive(first[0]);
    bridge.receive(first[1]);
    for (const part of request(2, '/api/attachments', big)) bridge.receive(part);
    expect(response(2).status).toBe(503);
    bridge.receive(first[2]);
    await settle();
    expect(response(1).status).toBe(200);
    expect(budget.take(MOBILE_ENVELOPE_PART_BYTES * 4)).toBe(true);
  });
});
