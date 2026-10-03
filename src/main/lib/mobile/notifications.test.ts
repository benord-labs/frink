import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WaitingChat } from './live-activity/counts';

const fixture = vi.hoisted(() => ({ waiting: new Map<string, WaitingChat>() }));
vi.mock('./live-activity/counts', () => ({
  readWaitingChats: async () => new Map(fixture.waiting),
}));
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
const TICK_MS = 5_000;
const sent = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));
/** A chat's run settles; its alert goes out once two looks show it isn't waiting on you. */
async function finish(chatId = 'chat') {
  publishSessionCompletion({ chatId, subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(2 * TICK_MS);
}
const address = {
  relay: 'https://relay.frink.dev',
  route: 'a'.repeat(64),
  key: 'K'.repeat(43),
  machine: 'Mac',
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frink-push-'));
  store = new MobilePairingStore(join(directory, 'mobile.json'));
  await store.initialize();
  await store.enable();
  const { pairing } = await store.pair(address);
  credential = await store.redeem(pairing.code, 'Phone');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ status: 'ok', id: 'receipt' }] }),
  });
  fixture.waiting.clear();
  vi.useFakeTimers();
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
  await finish();
  expect(fetchMock).not.toHaveBeenCalled();
  await store.notifications(credential.token, { token: push });
  await finish();
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('https://exp.host/--/api/v2/push/send');
  expect(JSON.parse(options.body)).toEqual([
    {
      to: push,
      title: 'A chat finished',
      body: 'Open it to see the result.',
      sound: 'default',
      ttl: 3600,
      interruptionLevel: 'active',
      collapseId: 'chat',
      data: {
        type: 'session-completed',
        deviceId: credential.deviceId,
        chatId: 'chat',
        subChatId: 'sub',
      },
    },
  ]);
  await store.disable();
  await finish();
  stop();
  await finish();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('removes dead tokens from receipts without removing a rotated registration', async () => {
  vi.useFakeTimers();
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  await finish();
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
  await vi.advanceTimersByTimeAsync(2 * TICK_MS);
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
    await finish();
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
    await finish();
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
  const { pairing } = await store.pair(address);
  const again = await store.redeem(pairing.code, 'Phone');
  await store.notifications(credential.token, { token: push });
  await store.notifications(again.token, { token: push });
  expect(store.notificationRecipients()).toEqual([{ id: again.deviceId, token: push }]);
});

it('batches paired phones into one Expo request and maps tickets by recipient', async () => {
  const { pairing } = await store.pair(address);
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
  await finish();
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
  await finish();
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

it('alerts once, time-sensitive, when a chat starts waiting on you and the wait holds', async () => {
  fixture.waiting.set('already', { kind: 'plan' });
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  fixture.waiting.set('chat', { kind: 'question', subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(TICK_MS);
  // One look is not enough: a question answered at the Mac within seconds stays off the phone.
  expect(fetchMock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5 * TICK_MS);
  expect(sent()).toEqual([
    {
      to: push,
      title: 'A chat has a question',
      body: 'Answer it to let the chat carry on.',
      sound: 'default',
      ttl: 3600,
      interruptionLevel: 'time-sensitive',
      collapseId: 'chat',
      data: { type: 'needs-you', deviceId: credential.deviceId, chatId: 'chat', subChatId: 'sub' },
    },
  ]);
  // Waiting again after the answer is a new wait, and a chat-less task opens the Queue.
  fixture.waiting.delete('chat');
  await vi.advanceTimersByTimeAsync(TICK_MS);
  fixture.waiting.set('chat', { kind: 'permission', subChatId: 'sub' });
  fixture.waiting.set('task:7', { kind: 'attention' });
  await vi.advanceTimersByTimeAsync(2 * TICK_MS);
  expect(sent().slice(1)).toEqual([
    expect.objectContaining({
      title: 'A chat needs your permission',
      body: 'Allow or deny it to let the chat carry on.',
      interruptionLevel: 'time-sensitive',
    }),
    expect.objectContaining({
      title: 'A task needs you',
      collapseId: 'task:7',
      data: { type: 'needs-you', deviceId: credential.deviceId },
    }),
  ]);
});

it('stays quiet for a wait answered before the second look', async () => {
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  fixture.waiting.set('chat', { kind: 'permission', subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(TICK_MS);
  fixture.waiting.delete('chat');
  await vi.advanceTimersByTimeAsync(4 * TICK_MS);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sends one plan alert, not a finished alert too, when a run parks on its plan', async () => {
  await store.notifications(credential.token, { token: push });
  stop = startMobileNotifications(store);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  publishSessionCompletion({ chatId: 'chat', subChatId: 'sub' });
  await vi.advanceTimersByTimeAsync(TICK_MS);
  fixture.waiting.set('chat', { kind: 'plan' });
  await vi.advanceTimersByTimeAsync(4 * TICK_MS);
  expect(sent()).toEqual([
    expect.objectContaining({
      title: 'A plan is ready',
      body: 'Review it, then approve or change it.',
      data: { type: 'needs-you', deviceId: credential.deviceId, chatId: 'chat' },
    }),
  ]);
});
