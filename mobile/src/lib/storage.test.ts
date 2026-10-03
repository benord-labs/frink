import { expect, it, vi } from 'vitest';
vi.mock('./relay/client', () => ({ relayRequest: vi.fn(), closeMobileRelay: vi.fn() }));
const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void keychain.set(key, value),
  deleteItemAsync: async () => {
    throw new Error('keychain busy');
  },
}));
import { readSavedComputers } from './storage';

it('loads the saved computers even when cleaning up single-computer keys fails', async () => {
  const deviceId = '00000000-0000-4000-8000-000000000001';
  keychain.set('frink.mobile.computers.v2', JSON.stringify({ selected: deviceId, ids: [deviceId] }));
  keychain.set(
    `frink.mobile.computer.${deviceId}`,
    JSON.stringify({
      relay: 'https://relay.example.test',
      route: 'c'.repeat(64),
      key: 'k'.repeat(43),
      token: 't'.repeat(43),
      deviceId,
      machineName: 'Mac',
      pairedAt: 1,
    }),
  );
  expect((await readSavedComputers()).selected).toBe(deviceId);
});
