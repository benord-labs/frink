import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobilePairingLink } from '@frink/shared/types/remote/mobile';
vi.mock('./relay/client', () => ({ relayRequest: vi.fn(), closeMobileRelay: vi.fn() }));
import { relayRequest } from './relay/client';
import { ApiError, pairComputer, parsePairing, requestMobile, uploadAttachment } from './api';

const pairing = {
  version: 3 as const,
  relay: 'https://relay.example.test',
  route: 'c'.repeat(64),
  key: 'a'.repeat(43),
  machine: 'Studio Mac',
  code: 'a'.repeat(43),
};
const connection = {
  relay: pairing.relay,
  route: pairing.route,
  key: pairing.key,
  token: 'b'.repeat(43),
  deviceId: 'phone',
  machineName: 'Studio Mac',
};
const transport = vi.mocked(relayRequest);
const reply = (value: unknown, status = 200) => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(value)),
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
describe('mobile API boundary', () => {
  it.each([
    'http://desktop.local',
    'https://user:pass@host.test',
    'https://host.test/path',
    'https://host.test?token=secret',
  ])('rejects unsafe relay origin %s', (relay) => {
    expect(() => parsePairing(JSON.stringify({ ...pairing, relay }))).toThrow('pairing code');
  });
  it('reads the desktop link and JSON form including the pinned identity', () => {
    expect(parsePairing(mobilePairingLink(pairing))).toEqual(pairing);
    expect(parsePairing(JSON.stringify(pairing))).toEqual(pairing);
    expect(() =>
      parsePairing(JSON.stringify({ version: 2, url: pairing.relay, code: pairing.code })),
    ).toThrow();
  });
  it('pairs through the pinned target and stores no invitation in the saved connection', async () => {
    transport.mockResolvedValue(reply({ ...connection, apiVersion: 3 }));
    expect(await pairComputer(JSON.stringify(pairing), 'My iPhone')).toEqual(connection);
    expect(transport).toHaveBeenCalledWith(
      pairing,
      '/pair',
      { 'Content-Type': 'application/json' },
      new TextEncoder().encode(JSON.stringify({ code: pairing.code, name: 'My iPhone' })),
      undefined,
      undefined,
    );
  });
  it('keeps bearer and request inside the encrypted transport envelope', async () => {
    transport.mockResolvedValue(reply({ data: [] }));
    expect(await requestMobile(connection, { type: 'flows' })).toEqual([]);
    expect(transport).toHaveBeenCalledWith(
      connection,
      '/api',
      { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
      new TextEncoder().encode('{"type":"flows"}'),
      undefined,
      undefined,
    );
  });
  it('does not retry a mutation when the response is lost', async () => {
    transport.mockRejectedValue(new ApiError('It may have arrived.', 0));
    await expect(requestMobile(connection, { type: 'cancelRun', id: 'run' })).rejects.toMatchObject(
      { status: 0 },
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'not json'])('reports a %j reply as an unreachable Mac', async (text) => {
    transport.mockResolvedValue({ status: 200, body: new TextEncoder().encode(text) });
    await expect(requestMobile(connection, { type: 'overview' })).rejects.toMatchObject({
      constructor: ApiError,
      status: 0,
    });
  });
  it.each([401, 409])('preserves desktop status %s', async (status) => {
    transport.mockResolvedValue(reply({ error: 'Refused' }, status));
    await expect(requestMobile(connection, { type: 'overview' })).rejects.toEqual(
      new ApiError('Refused', status),
    );
  });
  it('fetches only the local attachment URI and sends its bytes through the relay', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('file content'));
    vi.stubGlobal('fetch', fetcher);
    transport.mockResolvedValue(reply({ data: { id: 'saved' } }));
    expect(
      await uploadAttachment(
        connection,
        { chatId: 'chat', subChatId: 'sub' },
        { uri: 'file:///photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg' },
      ),
    ).toEqual({ id: 'saved' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('file:///photo.jpg');
    expect(transport.mock.calls[0][1]).toBe('/api/attachments');
    expect(new TextDecoder().decode(transport.mock.calls[0][3])).toBe('file content');
  });
});
