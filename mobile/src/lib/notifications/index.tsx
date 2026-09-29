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
import { ApiError } from '../api';
import { useConnection } from '../connection';
import { onTokenChanged } from './device';
import { reconcileRegistration, type AlertState } from './registration';

const SETUP_FAILED = 'This iPhone couldn’t update alerts. Check your connection and try again.';

type Alerts = AlertState & { busy: boolean; set: (enabled: boolean) => void };
const Context = createContext<Alerts | null>(null);

/**
 * Keeps this iPhone's alert registration on the Mac current: on open, on return to the app and
 * when iOS rotates the push token. One update runs at a time, so a refresh can't undo a tap.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const [state, setState] = useState<AlertState>({ enabled: false, denied: false, error: null });
  const [pending, setPending] = useState<boolean | null>(null);
  const active = useRef<AbortController | null>(null);
  const update = useCallback(
    async (desired?: boolean) => {
      if (!connection || (active.current && desired === undefined)) return;
      // A tap wins over a background refresh still in flight.
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      if (desired !== undefined) setPending(desired);
      try {
        const next = await reconcileRegistration(connection, desired, controller.signal);
        if (!controller.signal.aborted) setState(next);
      } catch (cause) {
        // Only a tap reports a failed update; an unreachable Mac already shows as offline.
        if (!controller.signal.aborted && desired !== undefined)
          setState((old) => ({
            ...old,
            error: cause instanceof ApiError ? cause.message : SETUP_FAILED,
          }));
      } finally {
        if (active.current === controller) active.current = null;
        if (!controller.signal.aborted) setPending(null);
      }
    },
    [connection],
  );
  useEffect(() => {
    void update();
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void update();
    });
    const stopTokens = onTokenChanged(() => void update());
    return () => {
      active.current?.abort();
      appState.remove();
      stopTokens();
    };
  }, [update]);
  const value: Alerts = {
    ...state,
    enabled: pending ?? state.enabled,
    busy: pending !== null,
    set: (enabled) => void update(enabled),
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationProvider is missing');
  return value;
}
