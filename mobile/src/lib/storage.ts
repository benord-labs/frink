import * as SecureStore from 'expo-secure-store';
import { connectionSchema, type Connection } from './api';

const KEY = 'frink.mobile.connection.v1';
export async function readConnection(): Promise<Connection | null> {
  const saved = await SecureStore.getItemAsync(KEY);
  if (!saved) return null;
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    await SecureStore.deleteItemAsync(KEY);
    return null;
  }
  const parsed = connectionSchema.safeParse(value);
  if (!parsed.success) {
    await SecureStore.deleteItemAsync(KEY);
    return null;
  }
  return parsed.data;
}
export async function saveConnection(value: Connection | null): Promise<void> {
  if (!value) return SecureStore.deleteItemAsync(KEY);
  await SecureStore.setItemAsync(KEY, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
