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
import {
  NO_COMPUTERS,
  addComputer,
  removeComputer,
  selectComputer,
  selectedComputer,
  type Computers,
} from './computers';
import { showNotice } from './notice';
import { forgetTurnedOn } from './notifications/default-on';
import { closeMobileRelay } from './relay/client';
import { readSavedComputers, savingComputers } from './storage';

type Session = {
  /** Every paired computer, in the order they were paired. */
  computers: Connection[];
  /** The computer the app is showing; null before the first pairing. */
  connection: Connection | null;
  loading: boolean;
  error: string | null;
  /** Adds and selects a computer; `replacing` drops a stale entry for the same machine. */
  connect: (connection: Connection, replacing?: string) => Promise<void>;
  select: (deviceId: string) => void;
  forget: (deviceId: string) => Promise<void>;
  request: <T extends MobileRequest>(
    request: T,
    signal?: AbortSignal,
  ) => Promise<MobileResponses[T['type']]>;
};
const Context = createContext<Session | null>(null);

const UNREADABLE = 'This iPhone couldn’t read its saved computers. Pair your computer again.';
const REVOKED =
  'Your Mac stopped accepting it. Make a new code in Frink on your Mac: Settings → Mobile.';

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Computers>(NO_COMPUTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(state);
  const saver = useRef(savingComputers(NO_COMPUTERS));
  useEffect(() => {
    let mounted = true;
    readSavedComputers()
      .then((saved) => {
        current.current = saved;
        saver.current = savingComputers(saved);
        if (mounted) setState(saved);
      })
      .catch(() => {
        if (mounted) setError(UNREADABLE);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const update = useCallback((change: (state: Computers) => Computers, rollback = true) => {
    const previous = current.current;
    const next = change(previous);
    const undoable = rollback && previous.computers !== next.computers;
    current.current = next;
    setState(next);
    const saved = saver.current.save(next);
    // A failed add or forget shows what is stored, so nothing unsaved looks paired; a later change
    // wins. A failed switch, or dropping a revoked computer, stays as shown and the next save
    // stores it.
    saved.catch(() => {
      if (current.current !== next || !undoable) return;
      current.current = saver.current.stored();
      setState(current.current);
    });
    return saved;
  }, []);
  // A save that failed (say, a switch) is retried when the app comes back, so a restart opens the
  // computer that was last shown.
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active' && saver.current.stored() !== current.current)
        saver.current.save(() => current.current).catch(() => undefined);
    });
    return () => listener.remove();
  }, []);
  const connect = useCallback(
    async (value: Connection, replacing?: string) => {
      await update((state) => addComputer(state, value, replacing));
      setError(null);
    },
    [update],
  );
  const select = useCallback(
    (deviceId: string) => void update((state) => selectComputer(state, deviceId)).catch(() => {}),
    [update],
  );
  const forget = useCallback(
    async (deviceId: string) => {
      if (current.current.selected === deviceId) closeMobileRelay();
      try {
        await update((state) => removeComputer(state, deviceId));
      } catch (error) {
        // The computer stays on screen, so the failure is said there, not on the pairing screen.
        showNotice(
          'This iPhone couldn’t forget it',
          'Try again, or remove this iPhone in Frink on that computer: Settings → Mobile.',
        );
        throw error;
      }
      // Only once it is really gone: a computer that stays keeps its alerts choice.
      forgetTurnedOn(deviceId);
    },
    [update],
  );
  // A revoked computer's credentials are dead, so it leaves the list even if storing that fails.
  const dropRevoked = useCallback(
    async (host: Connection) => {
      closeMobileRelay();
      const othersRemain = current.current.computers.length > 1;
      await update((state) => removeComputer(state, host.deviceId), false).catch(() => undefined);
      if (!othersRemain) return setError(REVOKED);
      showNotice(
        `${host.machineName} stopped accepting this iPhone`,
        'Pair it again from Frink on that computer: Settings → Mobile.',
      );
    },
    [update],
  );
  const request = useCallback(
    // Reason: Request failures and revocation share the MVP connection lifecycle.
    // fallow-ignore-next-line complexity
    async <T extends MobileRequest>(
      input: T,
      signal?: AbortSignal,
    ): Promise<MobileResponses[T['type']]> => {
      const host = selectedComputer(current.current);
      if (!host) throw new ApiError('Pair your computer to continue.', 401);
      try {
        return await requestMobile(host, input, signal);
      } catch (error) {
        if (isRevocation(error) && selectedComputer(current.current) === host)
          await dropRevoked(host);
        throw error;
      }
    },
    [dropRevoked],
  );
  const connection = selectedComputer(state);
  return (
    <Context.Provider
      value={{ computers: state.computers, connection, loading, error, connect, select, forget, request }}
    >
      {children}
    </Context.Provider>
  );
}

const isRevocation = (error: unknown) => error instanceof ApiError && error.status === 401;

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
