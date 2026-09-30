import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
const widget = vi.hoisted(() => ({ getInstances: vi.fn(), start: vi.fn() }));
// Shared objects, so the module re-imported for Frink Dev sees the same mocks.
const api = vi.hoisted(() => ({ requestNotifications: vi.fn() }));
const app = vi.hoisted(() => ({ currentState: 'active' }));
const constants = vi.hoisted(() => ({
  expoConfig: { scheme: 'frink-mobile', ios: { bundleIdentifier: 'dev.frink.mobile' } },
}));
vi.mock('../../widgets/frink-status', () => ({ default: widget }));
vi.mock('../api', () => api);
vi.mock('react-native', () => ({ AppState: app, Linking: {}, Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: constants }));
import type { Connection } from '../api';
import { endSession, reconcile, type Session } from './reconcile';

const host = { url: 'https://host.ts.net', token: 'secret' } as Connection;
const TOKEN = 'ab'.repeat(32);
const request = api.requestNotifications;

function card(id = 'one', token: string | null = TOKEN) {
  return {
    getId: () => id,
    end: vi.fn(async () => undefined),
    update: vi.fn(),
    getPushToken: vi.fn(async () => token),
    addPushTokenListener: vi.fn((_listener: (event: { pushToken: string }) => void) => ({
      remove: vi.fn(),
    })),
  };
}
let session: Session;
beforeEach(() => {
  vi.clearAllMocks();
  app.currentState = 'active';
  session = { sent: null };
  widget.getInstances.mockReturnValue([]);
  request.mockResolvedValue({ enabled: true, error: null });
});

it('starts a card only when on, in the foreground and something is running or needs you', async () => {
  const started = card();
  widget.start.mockReturnValue(started);
  expect(await reconcile(session, host, false, { running: 2, needsYou: 0 })).toBe(false);
  expect(await reconcile(session, host, true, undefined)).toBeUndefined();
  app.currentState = 'background';
  await reconcile(session, host, true, { running: 2, needsYou: 0 });
  expect(widget.start).not.toHaveBeenCalled();
  app.currentState = 'active';
  expect(await reconcile(session, host, true, { running: 2, needsYou: 1 })).toBe(false);
  expect(widget.start).toHaveBeenCalledExactlyOnceWith(
    { running: 2, needsYou: 1 },
    'frink-mobile://queue',
  );
  expect(started.update).not.toHaveBeenCalled();
});

it('starts a card for chats that need you even when nothing is running', async () => {
  widget.start.mockReturnValue(card());
  expect(await reconcile(session, host, true, { running: 0, needsYou: 2 })).toBe(false);
  expect(widget.start).toHaveBeenCalledExactlyOnceWith(
    { running: 0, needsYou: 2 },
    'frink-mobile://queue',
  );
});

it('leaves a running card to the Mac and ends any extras', async () => {
  const [first, extra] = [card('one'), card('two')];
  widget.getInstances.mockReturnValue([first, extra]);
  await reconcile(session, host, true, { running: 1, needsYou: 3 });
  expect(widget.start).not.toHaveBeenCalled();
  expect(first.update).not.toHaveBeenCalled();
  expect(first.end).not.toHaveBeenCalled();
  expect(extra.end).toHaveBeenCalledWith('immediate');
});

it('ends a card the Mac reports as idle', async () => {
  const shown = card();
  widget.getInstances.mockReturnValue([shown]);
  await reconcile(session, host, true, { running: 0, needsYou: 0 });
  expect(shown.end).toHaveBeenCalledWith('immediate');
});

it('turned off: ends every card and clears the token only if one was sent', async () => {
  const cards = [card('one'), card('two')];
  widget.getInstances.mockReturnValue(cards);
  await reconcile(session, host, false, { running: 1, needsYou: 0 });
  for (const shown of cards) expect(shown.end).toHaveBeenCalledWith('immediate');
  expect(request).not.toHaveBeenCalled();
  session.sent = TOKEN;
  await reconcile(session, host, false, { running: 1, needsYou: 0 });
  expect(request).toHaveBeenCalledExactlyOnceWith(host, { activityToken: null });
  expect(session.sent).toBeNull();
});

it('registers the card’s token once per change, including rotations', async () => {
  const shown = card();
  widget.getInstances.mockReturnValue([shown]);
  await reconcile(session, host, true, { running: 1, needsYou: 0 });
  await reconcile(session, host, true, { running: 2, needsYou: 0 });
  expect(request).toHaveBeenCalledExactlyOnceWith(host, { activityToken: TOKEN });
  expect(shown.addPushTokenListener).toHaveBeenCalledOnce();
  const rotated = 'cd'.repeat(32);
  shown.addPushTokenListener.mock.calls[0][0]({ pushToken: rotated });
  await vi.waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(host, { activityToken: rotated }),
  );
});

it('says when iOS refuses the card, and rethrows anything else', async () => {
  widget.start.mockImplementation(() => {
    throw Object.assign(new Error('off'), { code: 'ERR_LIVE_ACTIVITIES_NOT_SUPPORTED' });
  });
  expect(await reconcile(session, host, true, { running: 1, needsYou: 0 })).toBe(true);
  widget.start.mockImplementation(() => {
    throw new Error('too many');
  });
  await expect(reconcile(session, host, true, { running: 1, needsYou: 0 })).rejects.toThrow();
});

it('turned off while the token is still being sent: clears it once that lands', async () => {
  let land = () => {};
  request.mockReturnValueOnce(new Promise((resolve) => (land = () => resolve({ enabled: true }))));
  widget.getInstances.mockReturnValue([card()]);
  const sending = reconcile(session, host, true, { running: 1, needsYou: 0 });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  await reconcile(session, host, false, { running: 1, needsYou: 0 });
  land();
  await sending;
  expect(request).toHaveBeenLastCalledWith(host, { activityToken: null });
  expect(session.sent).toBeNull();
});

it('unpaired: stops listening, ends every card and clears the token on the old Mac', () => {
  const shown = card();
  const remove = vi.fn();
  widget.getInstances.mockReturnValue([shown]);
  endSession({ sent: null, listening: { id: 'one', remove } }, host);
  expect(remove).toHaveBeenCalledOnce();
  expect(shown.end).toHaveBeenCalledWith('immediate');
  expect(request).toHaveBeenCalledExactlyOnceWith(host, { activityToken: null });
});

it('Frink Dev shows the card but never registers for updates', async () => {
  vi.resetModules();
  constants.expoConfig.ios.bundleIdentifier = 'dev.frink.mobile.dev';
  onTestFinished(() => void (constants.expoConfig.ios.bundleIdentifier = 'dev.frink.mobile'));
  const dev = await import('./reconcile');
  const started = card();
  widget.start.mockReturnValue(started);
  await dev.reconcile(session, host, true, { running: 1, needsYou: 0 });
  expect(widget.start).toHaveBeenCalledOnce();
  expect(started.getPushToken).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
