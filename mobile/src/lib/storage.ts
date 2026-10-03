import * as SecureStore from 'expo-secure-store';
import type { Computers } from './computers';
import { computerSaver, readComputers, type KeyValue } from './computer-store';

const keychain: KeyValue = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

// Single-computer builds kept one pairing and one alerts flag; neither is carried over, and the
// computer is scanned again once.
const SINGLE_COMPUTER_KEYS = ['frink.mobile.connection.v1', 'frink.mobile.alerts-on.v1'];

export async function readSavedComputers(): Promise<Computers> {
  // Best effort: a failed cleanup must not keep the saved computers from loading.
  await Promise.all(SINGLE_COMPUTER_KEYS.map((key) => keychain.remove(key).catch(() => undefined)));
  return readComputers(keychain);
}
/** Saves later states of the computers just read, one at a time. */
export function savingComputers(stored: Computers) {
  return computerSaver(keychain, stored);
}
