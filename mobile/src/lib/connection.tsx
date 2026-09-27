import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import type { MobileRequest, MobileResponses } from '../../../src/shared/types/remote/mobile';
import { ApiError, requestMobile, type Connection } from './api';
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
        if (mounted) setError('Could not read the saved connection. Pair your computer again.');
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
    current.current = null;
    setConnection(null);
    try {
      await saveConnection(null);
    } catch (error) {
      setError(
        'Keychain could not be cleared. Revoke this phone in Settings → Mobile on your computer.',
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
      if (!host) throw new ApiError('Pair a computer to continue.', 401);
      try {
        return await requestMobile(host, input, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && current.current === host) {
          setError('This connection was revoked. Pair your computer again.');
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

// Reason: Foreground polling keeps host identity and stale-response checks together.
// fallow-ignore-next-line complexity
export function useResource<T extends MobileRequest>(input: T) {
  const { connection, request } = useConnection();
  const key = JSON.stringify([connection?.deviceId, connection?.url, input]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: MobileResponses[T['type']];
    error?: string;
  }>({ key });
  useEffect(() => {
    let cancelled = false;
    let pending: AbortController | null = null;
    // Reason: The polling request owns cancellation, visibility, and error state together.
    // fallow-ignore-next-line complexity
    async function refresh() {
      if (
        cancelled ||
        pending ||
        AppState.currentState === 'background' ||
        AppState.currentState === 'inactive'
      )
        return;
      pending = new AbortController();
      try {
        const data = await request(input, pending.signal);
        if (!cancelled && currentKey.current === key) setState({ key, data });
      } catch (error) {
        if (!cancelled && currentKey.current === key)
          setState((old) => ({
            key,
            data: old.key === key ? old.data : undefined,
            error: error instanceof Error ? error.message : 'Could not refresh.',
          }));
      } finally {
        pending = null;
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
      else pending?.abort();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      listener.remove();
      pending?.abort();
    };
    // The serialized input is the request identity, including host and pagination.
  }, [key, revision, request]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    refresh: () => setRevision((v) => v + 1),
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
