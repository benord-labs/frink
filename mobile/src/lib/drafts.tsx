import * as Crypto from 'expo-crypto';
import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useConnection } from './connection';

type Draft<T> = { value: T; requestId: string };
type DraftStore = {
  entries: Map<string, Draft<unknown>>;
  listeners: Set<() => void>;
};
const Context = createContext<DraftStore | null>(null);
const SEPARATOR = '\n';

// Drafts are kept per paired computer, so switching computers and back keeps a half-typed message.
// They live in memory only: a forgotten computer's drafts can no longer be reached and end with the
// app, and a retained request ID never causes a command to be sent automatically.
export function DraftProvider({ children }: { children: ReactNode }) {
  const store = useRef<DraftStore>({
    entries: new Map(),
    listeners: new Set(),
  });
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}

/** Reads and changes drafts without redrawing on each keystroke. Every change mints a new request
 *  id, so an id is never reused for different content. */
export function useDrafts() {
  const store = useContext(Context);
  if (!store) throw new Error('DraftProvider is missing');
  const deviceId = useConnection().connection?.deviceId;
  const keyOf = (name: string) => `${deviceId}${SEPARATOR}${name}`;
  const notify = () => store.listeners.forEach((listener) => listener());
  function get<T>(name: string, initial: T): Draft<T> {
    const key = keyOf(name);
    if (!store!.entries.has(key))
      store!.entries.set(key, { value: initial, requestId: Crypto.randomUUID() });
    return store!.entries.get(key) as Draft<T>;
  }
  function update<T>(name: string, value: T) {
    store!.entries.set(keyOf(name), { value, requestId: Crypto.randomUUID() });
    notify();
  }
  function clear(name: string, acknowledgedRequestId: string) {
    // An acknowledgement from an earlier screen must not erase a newer edit.
    if (store!.entries.get(keyOf(name))?.requestId !== acknowledgedRequestId) return;
    store!.entries.delete(keyOf(name));
    notify();
  }
  function subscribe(listener: () => void) {
    store!.listeners.add(listener);
    return () => void store!.listeners.delete(listener);
  }
  return { get, update, clear, subscribe };
}

export function useDraft<T>(name: string, initial: T) {
  const drafts = useDrafts();
  const initialValue = useRef(initial);
  const snapshot = () => drafts.get(name, initialValue.current);
  const draft = useSyncExternalStore(drafts.subscribe, snapshot, snapshot);
  return {
    ...draft,
    update: (value: T) => drafts.update(name, value),
    clear: (acknowledgedRequestId: string) => drafts.clear(name, acknowledgedRequestId),
  };
}
