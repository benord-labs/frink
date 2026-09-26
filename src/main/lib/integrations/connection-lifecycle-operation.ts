import { Mutex } from 'async-mutex';

const operationMutexes = new Map<string, Mutex>();

async function withLifecycleOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const mutex = operationMutexes.get(key) ?? new Mutex();
  operationMutexes.set(key, mutex);
  try {
    return await mutex.runExclusive(operation);
  } finally {
    if (!mutex.isLocked() && operationMutexes.get(key) === mutex) operationMutexes.delete(key);
  }
}

/** Serialize lifecycle mutations for one connection in this app process. */
export async function withConnectionLifecycleOperation<T>(
  connectionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLifecycleOperation(`connection:${connectionId}`, operation);
}

/** Serialize package state with connection finalization for one installed plugin. */
export async function withPluginLifecycleOperation<T>(
  pluginId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLifecycleOperation(`plugin:${pluginId}`, operation);
}

/** Serializes credential-row resolutions: concurrent keychain probes must not interleave their writes. */
export async function withCredentialRowOperation<T>(
  rowId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLifecycleOperation(`credential-row:${rowId}`, operation);
}
