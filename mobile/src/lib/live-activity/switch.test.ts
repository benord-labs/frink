import { beforeEach, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock('expo-secure-store', () => store);
import { readSwitch } from './switch';
beforeEach(() => vi.resetAllMocks());
it('shows the Lock Screen card until it is turned off', async () => {
  store.getItemAsync.mockResolvedValue(null);
  expect(await readSwitch()).toBe(true);
  store.getItemAsync.mockRejectedValue(new Error('keychain locked'));
  expect(await readSwitch()).toBe(true);
  store.getItemAsync.mockResolvedValue('off');
  expect(await readSwitch()).toBe(false);
  store.getItemAsync.mockResolvedValue('on');
  expect(await readSwitch()).toBe(true);
});
