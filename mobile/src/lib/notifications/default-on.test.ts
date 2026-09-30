import { beforeEach, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('expo-secure-store', () => store);
vi.mock('react-native', () => ({ Platform: platform }));
import { markTurnedOn, turnOnByDefault } from './default-on';
beforeEach(() => {
  vi.resetAllMocks();
  platform.OS = 'ios';
  store.setItemAsync.mockResolvedValue(undefined);
});
it('turns alerts on once per pairing, so turning them off sticks', async () => {
  store.getItemAsync.mockResolvedValue(null);
  expect(await turnOnByDefault('phone')).toBe(true);
  markTurnedOn('phone');
  expect(store.setItemAsync).toHaveBeenCalledWith('frink.mobile.alerts-on.v1', 'phone');
  store.getItemAsync.mockResolvedValue('phone');
  expect(await turnOnByDefault('phone')).toBe(false);
  expect(await turnOnByDefault('phone-paired-to-another-mac')).toBe(true);
});
it('never asks from a browser preview or when the choice can’t be read', async () => {
  store.getItemAsync.mockRejectedValue(new Error('keychain locked'));
  expect(await turnOnByDefault('phone')).toBe(false);
  platform.OS = 'web';
  store.getItemAsync.mockResolvedValue(null);
  expect(await turnOnByDefault('phone')).toBe(false);
});
