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
  expect(open).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat' });
  expect(native.clearLastNotificationResponse).toHaveBeenCalledOnce();
  stop();
  expect(remove).toHaveBeenCalledOnce();
});
