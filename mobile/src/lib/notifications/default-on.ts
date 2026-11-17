import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

// The paired computers whose alerts were already turned on once: a later "off" in Settings sticks,
// including after switching to another computer and back.
const KEY = 'frink.mobile.alerts-on.v2';
const idsSchema = z.array(z.string());

/** The stored ids; an unreadable value counts as none, and the next change overwrites it. */
async function read(): Promise<string[]> {
  const saved = await SecureStore.getItemAsync(KEY);
  try {
    const parsed = idsSchema.safeParse(JSON.parse(saved ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

// Changes run one at a time, so two of them never read the same list and overwrite each other.
let changes: Promise<unknown> = Promise.resolve();
function change(edit: (ids: string[]) => string[]) {
  changes = changes
    .then(async () => SecureStore.setItemAsync(KEY, JSON.stringify(edit(await read()))))
    .catch(() => undefined);
}

/**
 * Alerts start on: the first open after pairing a computer turns them on, which is when iOS asks.
 * Browser previews have no iPhone alerts, so they never ask.
 */
export async function turnOnByDefault(deviceId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  // Read after any queued change, so a quick switch back sees the latest choice.
  return changes.then(read).then(
    (ids) => !ids.includes(deviceId),
    () => false,
  );
}

export function markTurnedOn(deviceId: string) {
  change((ids) => (ids.includes(deviceId) ? ids : [...ids, deviceId]));
}

/** A forgotten computer starts over: pairing it again turns its alerts on again. */
export function forgetTurnedOn(deviceId: string) {
  if (Platform.OS === 'web') return;
  change((ids) => ids.filter((id) => id !== deviceId));
}
