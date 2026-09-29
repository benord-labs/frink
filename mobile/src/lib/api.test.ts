import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, pairComputer, parsePairing, requestMobile } from './api';

const pairing = { version: 2, url: 'https://desktop.example.ts.net:8443', code: 'a'.repeat(43) };
const connection = {
  url: pairing.url,
  token: 'b'.repeat(43),
  deviceId: 'phone',
  machineName: 'My Mac',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('native mobile boundary', () => {
  it.each([
    'http://desktop.local',
    'https://user:pass@host.test',
    'https://host.test/path',
    'https://host.test?token=secret',
  ])('rejects unsafe pairing origin %s', (url) => {
    expect(() => parsePairing(JSON.stringify({ ...pairing, url }))).toThrow('pairing code');
  });
  it('pairs only against the explicitly supplied origin and checks API compatibility', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: connection.token,
          deviceId: 'phone',
          machineName: 'My Mac',
          apiVersion: 2,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await pairComputer(JSON.stringify(pairing), 'My iPhone')).toEqual(connection);
    expect(fetcher).toHaveBeenCalledWith(
      `${pairing.url}/pair`,
      expect.objectContaining({
        redirect: 'error',
        body: JSON.stringify({ code: pairing.code, name: 'My iPhone' }),
      }),
    );
  });
  it('keeps credentials in the authorization header and sends a validated request unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await requestMobile(connection, { type: 'flows' })).toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(
      `${pairing.url}/api`,
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.token}`,
        },
        body: '{"type":"flows"}',
      }),
    );
  });
  it('does not retry a mutation after the response is lost', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('connection reset'));
    vi.stubGlobal('fetch', fetcher);
    await expect(requestMobile(connection, { type: 'cancelRun', id: 'run' })).rejects.toThrow(
      'it may have arrived',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves authorization rejection for the session to clear protected state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"Revoked"}', { status: 401 })),
    );
    await expect(requestMobile(connection, { type: 'overview' })).rejects.toEqual(
      new ApiError('Revoked', 401),
    );
  });
  it('reports domain conflicts rather than returning a successful action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"Question closed"}', { status: 409 })),
    );
    await expect(requestMobile(connection, { type: 'overview' })).rejects.toMatchObject({
      status: 409,
      message: 'Question closed',
    });
  });
});
