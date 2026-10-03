import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useIsFocused } from '@react-navigation/native';
import { AppState } from 'react-native';
import type { MobileRequest, MobileResponses } from '@frink/shared/types/remote/mobile';
import { ApiError, requestMobile, type Connection } from './api';
import { closeMobileRelay } from './relay/client';
import { readConnection, saveConnection } from './storage';

type Session = {
  connection: Connection | null;
  loading: boolean;
  error: string | null;
  connect: (connection: Connection) => Promise<void>;
  disconnect: () => Promise<void>;
  request: <T extends MobileRequest>(
    request: T,
    signal?: AbortSignal,
  ) => Promise<MobileResponses[T['type']]>;
};
const Context = createContext<Session | null>(null);
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(connection);
  current.current = connection;
  useEffect(() => {
    let mounted = true;
    readConnection()
      .then((saved) => {
        if (mounted) setConnection(saved);
      })
      .catch(() => {
        if (mounted)
          setError('This iPhone couldn’t read its saved connection. Pair your Mac again.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const connect = useCallback(async (value: Connection) => {
    await saveConnection(value);
    setError(null);
    setConnection(value);
  }, []);
  const disconnect = useCallback(async () => {
    closeMobileRelay();
    current.current = null;
    setConnection(null);
    try {
      await saveConnection(null);
    } catch (error) {
      setError(
        'This iPhone couldn’t forget the connection. Remove it in Frink on your Mac: Settings → Mobile.',
      );
      throw error;
    }
  }, []);
  const request = useCallback(
    // Reason: Request failures and revocation share the MVP connection lifecycle.
    // fallow-ignore-next-line complexity
    async <T extends MobileRequest>(
      input: T,
      signal?: AbortSignal,
    ): Promise<MobileResponses[T['type']]> => {
      const host = current.current;
      if (!host) throw new ApiError('Pair your Mac to continue.', 401);
      try {
        return await requestMobile(host, input, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && current.current === host) {
          setError(
            'Your Mac stopped accepting it. Make a new code in Frink on your Mac: Settings → Mobile.',
          );
          await disconnect();
        }
        throw error;
      }
    },
    [disconnect],
  );
  return (
    <Context.Provider value={{ connection, loading, error, connect, disconnect, request }}>
      {children}
    </Context.Provider>
  );
}
export function useConnection() {
  const value = useContext(Context);
  if (!value) throw new Error('ConnectionProvider is missing');
  return value;
}

/** What a failed refresh reports: its message, and the HTTP status (0 = unreachable). */
function failureState(error: unknown) {
  return {
    error: error instanceof Error ? error.message : 'Could not refresh.',
    errorStatus: error instanceof ApiError ? error.status : undefined,
  };
}

// Reason: Foreground polling keeps host identity and stale-response checks together.
// fallow-ignore-next-line complexity
export function useResource<T extends MobileRequest>(
  input: T,
  // `enabled: false` waits for inputs that aren't known yet; `interval` spaces out costly reads.
  // `keep` shows the previous rows while a grown window or new search loads, instead of a blank list.
  {
    enabled = true,
    interval = 3000,
    keep = false,
  }: { enabled?: boolean; interval?: number; keep?: boolean } = {},
) {
  const { connection, request } = useConnection();
  // Polls only while its own screen is visible (a hidden tab or a screen under a pushed one waits).
  const focused = useIsFocused();
  const key = JSON.stringify([connection?.deviceId, connection?.route, input]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [revision, setRevision] = useState(0);
  // Only a pull-to-refresh gesture shows the spinner; mounts, focus and command follow-ups stay silent.
  const pulled = useRef(false);
  const [state, setState] = useState<{
    key: string;
    data?: MobileResponses[T['type']];
    error?: string;
    errorStatus?: number;
    updatedAt?: number;
    refreshing?: boolean;
  }>({ key });
  useEffect(() => {
    if (!focused || !connection || !enabled) return;
    let cancelled = false;
    let pending: AbortController | null = null;
    // Reason: The polling request owns cancellation, visibility, and error state together.
    // fallow-ignore-next-line complexity
    async function refresh(visible = false) {
      if (
        cancelled ||
        pending ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      )
        return;
      pending = new AbortController();
      const controller = pending;
      if (visible) setState((old) => ({ ...old, refreshing: true }));
      try {
        const data = await request(input, pending.signal);
        if (!cancelled && currentKey.current === key)
          setState({ key, data, updatedAt: Date.now(), refreshing: false });
      } catch (error) {
        if (!cancelled && currentKey.current === key && !controller.signal.aborted)
          setState((old) => ({
            ...(old.key === key ? { data: old.data, updatedAt: old.updatedAt } : {}),
            key,
            refreshing: false,
            ...failureState(error),
          }));
      } finally {
        pending = null;
        if (!cancelled && controller.signal.aborted)
          setState((old) => ({ ...old, refreshing: false }));
      }
    }
    void refresh(pulled.current);
    pulled.current = false;
    const timer = setInterval(() => void refresh(), interval);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
      else pending?.abort();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      listener.remove();
      pending?.abort();
    };
    // The serialized input is the request identity, including host and pagination.
  }, [key, revision, request, focused, enabled, interval]);
  const current = state.key === key;
  return {
    data: current || keep ? state.data : undefined,
    /** True while `data` belongs to the previous request (kept by `keep`). */
    stale: !current && state.data !== undefined,
    error: state.key === key ? state.error : undefined,
    errorStatus: state.key === key ? state.errorStatus : undefined,
    updatedAt: state.key === key ? state.updatedAt : undefined,
    refreshing: focused && state.key === key && !!state.refreshing,
    refresh: () => setRevision((v) => v + 1),
    pull: () => {
      pulled.current = true;
      setRevision((v) => v + 1);
    },
  };
}

export function useAction() {
  const { request } = useConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  async function run<T extends MobileRequest>(
    input: T,
  ): Promise<MobileResponses[T['type']] | undefined> {
    if (locked.current) return undefined;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      return await request(input);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not complete the action.');
      return undefined;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { run, busy, error };
}
