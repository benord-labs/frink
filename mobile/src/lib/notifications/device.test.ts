import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  requestPermissionsAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
  addPushTokenListener: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  setNotificationCategoryAsync: vi.fn(() => Promise.resolve()),
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  DEFAULT_ACTION_IDENTIFIER: 'open',
}));
vi.mock('expo-notifications', () => native);
vi.mock('expo-constants', () => ({ default: { easConfig: { projectId: 'project' } } }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
import { permission, pushToken, onNotificationOpened } from './device';
beforeEach(() => vi.clearAllMocks());
it('never requests permission during a background settings refresh', async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: false });
  expect(await permission()).toBe(false);
  expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
  native.requestPermissionsAsync.mockResolvedValue({ granted: true });
  expect(await permission(true)).toBe(true);
});
it('accepts provisional permission and registers with the actual EAS project', async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: false, ios: { status: 3 } });
  expect(await permission()).toBe(true);
  native.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExpoPushToken[device]' });
  expect(await pushToken()).toBe('ExpoPushToken[device]');
  expect(native.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project' });
});
it('consumes cold-start and live notification taps once and removes its listener', () => {
  const response = {
    actionIdentifier: 'open',
    notification: { request: { identifier: 'one', content: { data: { chatId: 'chat' } } } },
  };
  const remove = vi.fn();
  native.getLastNotificationResponse.mockReturnValue(response);
  native.addNotificationResponseReceivedListener.mockReturnValue({ remove });
  const open = vi.fn();
  const stop = onNotificationOpened(open);
  native.addNotificationResponseReceivedListener.mock.calls[0][0](response);
  expect(open).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat' }, 'open');
  expect(native.clearLastNotificationResponse).toHaveBeenCalledOnce();
  stop();
  expect(remove).toHaveBeenCalledOnce();
});
it('passes on Allow and Deny taps, but no other action', () => {
  const tap = (actionIdentifier: string, identifier: string) => ({
    actionIdentifier,
    notification: { request: { identifier, content: { data: { chatId: 'chat' } } } },
  });
  native.getLastNotificationResponse.mockReturnValue(null);
  native.addNotificationResponseReceivedListener.mockReturnValue({ remove: vi.fn() });
  const open = vi.fn();
  onNotificationOpened(open);
  const consume = native.addNotificationResponseReceivedListener.mock.calls[0][0];
  consume(tap('allow', 'one'));
  consume(tap('reply', 'two'));
  consume(tap('deny', 'three'));
  expect(open.mock.calls).toEqual([
    [{ chatId: 'chat' }, 'allow'],
    [{ chatId: 'chat' }, 'deny'],
  ]);
});
it('drops a tap delivered twice, but lets the same alert be answered with the other button', () => {
  const tap = (actionIdentifier: string) => ({
    actionIdentifier,
    notification: { request: { identifier: 'one', content: { data: { chatId: 'chat' } } } },
  });
  native.getLastNotificationResponse.mockReturnValue(null);
  native.addNotificationResponseReceivedListener.mockReturnValue({ remove: vi.fn() });
  const open = vi.fn();
  onNotificationOpened(open);
  const listeners = native.addNotificationResponseReceivedListener.mock.calls;
  const consume = listeners[listeners.length - 1][0];
  consume(tap('allow'));
  consume(tap('allow'));
  consume(tap('deny'));
  expect(open.mock.calls).toEqual([
    [{ chatId: 'chat' }, 'allow'],
    [{ chatId: 'chat' }, 'deny'],
  ]);
});
