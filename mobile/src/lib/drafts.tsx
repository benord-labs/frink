import * as Crypto from 'expo-crypto';
import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';

type Draft<T> = { value: T; requestId: string };
type DraftStore = {
  entries: Map<string, Draft<unknown>>;
  listeners: Set<() => void>;
};
const Context = createContext<DraftStore | null>(null);

// The connection-scoped provider is discarded on disconnect or revocation. Nothing is written
// to disk, and a retained request ID never causes a command to be sent automatically.
export function DraftProvider({ children }: { children: ReactNode }) {
  const store = useRef<DraftStore>({
    entries: new Map(),
    listeners: new Set(),
  });
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}

export function useDraft<T>(key: string, initial: T) {
  const store = useContext(Context);
  if (!store) throw new Error('DraftProvider is missing');
  const initialValue = useRef(initial);
  function snapshot(): Draft<T> {
    if (!store!.entries.has(key))
      store!.entries.set(key, {
        value: initialValue.current,
        requestId: Crypto.randomUUID(),
      });
    return store!.entries.get(key) as Draft<T>;
  }
  const draft = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
      };
    },
    snapshot,
    snapshot,
  );
  function update(value: T) {
    store!.entries.set(key, { value, requestId: Crypto.randomUUID() });
    store!.listeners.forEach((listener) => listener());
  }
  function clear(acknowledgedRequestId: string) {
    // An acknowledgement from an earlier screen must not erase a newer edit.
    if (store!.entries.get(key)?.requestId !== acknowledgedRequestId) return;
    store!.entries.delete(key);
    store!.listeners.forEach((listener) => listener());
  }
  return { ...draft, update, clear };
}
