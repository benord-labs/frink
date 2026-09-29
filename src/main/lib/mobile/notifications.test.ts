import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobilePairingStore } from './pairing-store';
import { startMobileNotifications } from './notifications';
import { publishSessionCompletion } from '../socket/streaming/live-stream/completion-events';
import { createMobileApp } from './server';

let directory: string;
let store: MobilePairingStore;
let credential: { token: string; deviceId: string };
let stop: (() => void) | undefined;
const push = 'ExpoPushToken[phone-one]';
const fetchMock = vi.fn();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-push-'));
  store = new MobilePairingStore(join(directory, 'mobile.json'));
  await store.initialize();
  await store.enable();
  const { pairing } = await store.pair('https://host.ts.net');
  credential = await store.redeem(pairing.code, 'Phone');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok', id: 'receipt' }] }),
  });
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('binds registration to the authenticated phone and never exposes push tokens in status', async () => {
  const app = createMobileApp(store, vi.fn());
  const request = (token: string, body: unknown) =>
    app.request('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  expect((await request('bad', { token: push })).status).toBe(401);
  expect((await request(credential.token, { token: 'https://other-host' })).status).toBe(400);
  expect((await request(credential.token, { token: push, deviceId: 'another' })).status).toBe(400);
  expect((await request(credential.token, { token: push })).status).toBe(200);
  expect(JSON.stringify(store.status())).not.toContain(push);
  const restored = new MobilePairingStore(join(directory, 'mobile.json'));
  await restored.initialize();
  expect(restored.notificationRecipients()).toEqual([{ id: credential.deviceId, token: push }]);
  await store.revoke(credential.deviceId);
  expect((await request(credential.token, { token: push })).status).toBe(401);
  expect(store.notificationRecipients()).toEqual([]);
});

it('sends only a generic alert with identifiers, and stops after disable or shutdown', async () => {
  stop = startMobileNotifications(store);
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  expect(fetchMock).not.toHaveBeenCalled();
  await store.notifications(credential.token, { token: push });
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('https://exp.host/--/api/v2/push/send');
  expect(JSON.parse(options.body)).toEqual([
    {
      to: push,
      title: 'Frink',
      body: 'A chat on your Mac has finished.',
      sound: 'default',
      ttl: 3600,
      data: {
        type: 'session-completed',
        deviceId: credential.deviceId,
        chatId: 'chat',
        subChatId: 'sub',
      },
    },
  ]);
  await store.disable();
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  stop();
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('removes dead tokens from receipts without removing a rotated registration', async () => {
  vi.useFakeTimers();
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(0);
  await store.notifications(credential.token, { token: 'ExpoPushToken[new-token]' });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: { receipt: { status: 'error', details: { error: 'DeviceNotRegistered' } } },
    }),
  });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(store.notificationRecipients()[0].token).toBe('ExpoPushToken[new-token]');
  await store.notificationFailed(credential.deviceId, 'ExpoPushToken[new-token]', true);
  expect(store.notificationRecipients()).toEqual([]);
});

it('contains network errors and exposes actionable delivery status', async () => {
  await store.notifications(credential.token, { token: push });
  fetchMock.mockRejectedValue(new Error('network offline'));
  stop = startMobileNotifications(store);
  expect(() => publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' })).not.toThrow();
  await vi.waitFor(async () =>
    expect((await store.notifications(credential.token, {})).error).toContain('couldn’t deliver'),
  );
});

it.each([undefined, '', '   ', 42, null])(
  'reports malformed successful push tickets as delivery failures (id: %s)',
  async (id) => {
    vi.useFakeTimers();
    await store.notifications(credential.token, { token: push });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id }] }),
    });
    stop = startMobileNotifications(store);
    publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
    await vi.waitFor(async () =>
      expect((await store.notifications(credential.token, {})).error).toContain('couldn’t deliver'),
    );
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);

it.each(['ok', 'DeviceNotRegistered', 'MessageRateExceeded'] as const)(
  'handles provider delivery receipts (%s)',
  async (result) => {
    vi.useFakeTimers();
    await store.notifications(credential.token, { token: push });
    stop = startMobileNotifications(store);
    publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          receipt:
            result === 'ok' ? { status: 'ok' } : { status: 'error', details: { error: result } },
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const state = await store.notifications(credential.token, {});
      expect(state.enabled).toBe(result !== 'DeviceNotRegistered');
      expect(state.error).toEqual(
        {
          ok: null,
          DeviceNotRegistered: expect.stringContaining('couldn’t reach this iPhone'),
          MessageRateExceeded: 'Your Mac couldn’t deliver the last alert.',
        }[result],
      );
    });
  },
);

it('moves a push token to the newest pairing that registers it', async () => {
  const { pairing } = await store.pair('https://host.ts.net');
  const again = await store.redeem(pairing.code, 'Phone');
  await store.notifications(credential.token, { token: push });
  await store.notifications(again.token, { token: push });
  expect(store.notificationRecipients()).toEqual([{ id: again.deviceId, token: push }]);
});

it('batches paired phones into one Expo request and maps tickets by recipient', async () => {
  const { pairing } = await store.pair('https://host.ts.net');
  const other = await store.redeem(pairing.code, 'Other phone');
  await store.notifications(credential.token, { token: push });
  await store.notifications(other.token, { token: 'ExpoPushToken[other]' });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: [
        { status: 'ok', id: 'one' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
      ],
    }),
  });
  stop = startMobileNotifications(store);
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  await vi.waitFor(() =>
    expect(store.notificationRecipients()).toEqual([{ id: credential.deviceId, token: push }]),
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(
    JSON.parse(fetchMock.mock.calls[0][1].body).map((item: { to: string }) => item.to),
  ).toEqual([push, 'ExpoPushToken[other]']);
});

it('retains receipt IDs through a transient failure and observes the eventual rejection', async () => {
  vi.useFakeTimers();
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(0);
  fetchMock.mockRejectedValueOnce(new Error('temporarily offline'));
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(store.notificationRecipients()).toHaveLength(1);
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: {
        receipt: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      },
    }),
  });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await vi.waitFor(() => expect(store.notificationRecipients()).toEqual([]));
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ ids: ['receipt'] });
});
