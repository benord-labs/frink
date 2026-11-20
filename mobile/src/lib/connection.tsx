import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import {
  cacheWriter,
  clearCache,
  type CacheWrite,
  freshSince,
  prefetch,
  prefetched,
  readCache,
  resourceKey,
  share,
} from './resource/cache';
import { FIRST_PAGES } from './resource/first-pages';
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
  /** Asks `host`, the selected computer by default, so an answer is tied to who was asked. */
  request: <T extends MobileRequest>(
    request: T,
    signal?: AbortSignal,
    host?: Connection | null,
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
      clearCache(deviceId);
    },
    [update],
  );
  // A revoked computer's credentials are dead, so it leaves the list even if storing that fails.
  const dropRevoked = useCallback(
    async (host: Connection) => {
      closeMobileRelay();
      clearCache(host.deviceId);
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
      host = selectedComputer(current.current),
    ): Promise<MobileResponses[T['type']]> => {
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
  // A layout effect runs before every screen's first read, even a screen mounted in this commit.
  useLayoutEffect(() => {
    if (connection) prefetchFirstPages(connection, request);
  }, [connection, request]);
  return (
    <Context.Provider
      value={{
        computers: state.computers,
        connection,
        loading,
        error,
        connect,
        select,
        forget,
        request,
      }}
    >
      {children}
    </Context.Provider>
  );
}

const isRevocation = (error: unknown) => error instanceof ApiError && error.status === 401;

function prefetchFirstPages(host: Connection, request: Session['request']) {
  for (const input of FIRST_PAGES)
    prefetch(resourceKey(host.deviceId, host.route, input), host.deviceId, () =>
      request(input, undefined, host),
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

type Response<T extends MobileRequest> = MobileResponses[T['type']];

/** Calls `tick` an interval after `since`, then an interval after each tick settles. The interval is
 *  read when scheduling, and `retime` re-reads it for the tick already waiting. */
function pollTimer(tick: () => Promise<void>, every: () => number, since: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        void tick().then(() => {
          since = Date.now();
          if (!stopped) schedule();
        });
      },
      Math.max(0, since + every() - Date.now()),
    );
  };
  schedule();
  return {
    retime: () => {
      if (timer !== undefined) schedule();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
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
  const key = resourceKey(connection?.deviceId ?? '', connection?.route ?? '', input);
  const currentKey = useRef(key);
  currentKey.current = key;
  // Read on each tick, so a new interval applies next time without restarting the in-flight poll.
  const every = useRef(interval);
  every.current = interval;
  const [revision, setRevision] = useState(0);
  // Only a pull-to-refresh gesture shows the spinner; mounts, focus and command follow-ups stay silent.
  const pulled = useRef(false);
  // An asked-for refresh reads now, even when the cached answer is younger than the interval.
  const forced = useRef(false);
  // Counts answers that arrived another way, so a poll sent before one cannot draw over it.
  const puts = useRef(0);
  const [state, setState] = useState<{
    key: string;
    data?: Response<T>;
    error?: string;
    errorStatus?: number;
    updatedAt?: number;
    refreshing?: boolean;
  }>(() => {
    const cached = readCache<Response<T>>(key);
    return { key, data: cached?.data, updatedAt: cached?.updatedAt };
  });
  // Coming back to an earlier request (a re-expanded list) draws its old answer as stale, not its own.
  const [asked, setAsked] = useState(key);
  if (asked !== key) {
    setAsked(key);
    if (state.key === key) setState(({ data, updatedAt }) => ({ key: '', data, updatedAt }));
  }
  const current = state.key === key;
  // A shorter interval (a chat that starts running) brings the waiting tick forward.
  const retime = useRef<() => void>(undefined);
  useEffect(() => {
    retime.current?.();
  }, [interval]);
  useEffect(() => {
    if (!focused || !connection || !enabled) return;
    const { deviceId } = connection;
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
      const write = cacheWriter(deviceId);
      const seen = puts.current;
      try {
        // A shared prefetch is not aborted with this screen: other screens may be waiting on it.
        const next = await (prefetched<Response<T>>(key) ??
          request(input, pending.signal, connection));
        if (!cancelled && currentKey.current === key && puts.current !== seen)
          setState((old) => ({ ...old, refreshing: false }));
        else if (!cancelled && currentKey.current === key) {
          const data = share(readCache<Response<T>>(key)?.data, next);
          const updatedAt = Date.now();
          write(key, data, updatedAt);
          setState({ key, data, updatedAt, refreshing: false });
        }
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
    // A new request reads at once; a remount or refocus waits out its cached answer's interval.
    const since = current && !forced.current ? freshSince(key, every.current) : undefined;
    forced.current = false;
    if (since === undefined) void refresh(pulled.current);
    pulled.current = false;
    const timer = pollTimer(refresh, () => every.current, since ?? Date.now());
    retime.current = timer.retime;
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
      else pending?.abort();
    });
    return () => {
      cancelled = true;
      retime.current = undefined;
      timer.stop();
      listener.remove();
      pending?.abort();
    };
    // The serialized input is the request identity, including host and pagination.
  }, [key, revision, request, focused, enabled]);
  // A new request (another chat, say) draws its cached answer until its own poll lands.
  const own = current && state.data !== undefined ? state : undefined;
  const shown = own ?? readCache<Response<T>>(key);
  const data = shown ? shown.data : keep ? state.data : undefined;
  const refresh = () => {
    forced.current = true;
    setRevision((v) => v + 1);
  };
  /** Shows an answer that arrived another way, such as a live update, if `write` may store it. */
  const put = (next: Response<T>, write: CacheWrite) => {
    if (currentKey.current !== key) return;
    const data = share(readCache<Response<T>>(key)?.data, next);
    const updatedAt = Date.now();
    if (!write(key, data, updatedAt)) return;
    puts.current++;
    setState({ key, data, updatedAt, refreshing: false });
  };
  return {
    data,
    /** True while `data` is not this request's own answer: a cached one, or the previous request's. */
    stale: !own && data !== undefined,
    error: current ? state.error : undefined,
    errorStatus: current ? state.errorStatus : undefined,
    updatedAt: shown?.updatedAt,
    refreshing: focused && current && !!state.refreshing,
    refresh,
    put,
    pull: () => {
      pulled.current = true;
      refresh();
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
