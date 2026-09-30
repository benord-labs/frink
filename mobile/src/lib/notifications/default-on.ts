import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// The pairing whose alerts were last turned on for the user: a later "off" in Settings sticks.
const KEY = 'frink.mobile.alerts-on.v1';

/**
 * Alerts start on: the first open after pairing a Mac turns them on, which is when iOS asks.
 * Browser previews have no iPhone alerts, so they never ask.
 */
export async function turnOnByDefault(deviceId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  return SecureStore.getItemAsync(KEY).then((saved) => saved !== deviceId, () => false);
}

export function markTurnedOn(deviceId: string) {
  SecureStore.setItemAsync(KEY, deviceId).catch(() => undefined);
}
