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
import { markTurnedOn, turnOnByDefault } from './default-on';
import { onTokenChanged } from './device';
import { mayStartUpdate, reconcileRegistration, type AlertState } from './registration';

const SETUP_FAILED = 'This iPhone couldn’t update alerts. Check your connection and try again.';

const UNREGISTER_WAIT_MS = 1500;

type Alerts = AlertState & {
  busy: boolean;
  set: (enabled: boolean) => void;
  /** Removes this iPhone's alerts before the Mac is forgotten; no refresh can re-register after. */
  unregister: () => Promise<void>;
  /** Undoes `unregister`'s hold when the Mac could not be forgotten after all. */
  resume: () => void;
};
const Context = createContext<Alerts | null>(null);

/** Turns alerts off on the Mac, giving up after a moment: forgetting must work when it is away. */
async function removeBeforeForget(
  update: (desired: false, forget: AbortController) => Promise<boolean>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNREGISTER_WAIT_MS);
  try {
    await update(false, controller);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Keeps this iPhone's alert registration on the Mac current: on open, on return to the app and
 * when iOS rotates the push token. One update runs at a time, so a refresh can't undo a tap.
 * The first open after pairing turns alerts on, as if tapped, which is when iOS asks to allow them.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const [state, setState] = useState<AlertState>({ enabled: false, denied: false, error: null });
  const [pending, setPending] = useState<boolean | null>(null);
  const active = useRef<AbortController | null>(null);
  const forgetting = useRef<Promise<void> | null>(null);
  const shown = useRef(connection);
  shown.current = connection;
  const update = useCallback(
    /** Whether this update reached the Mac. Only the forget's own removal runs while forgetting. */
    async (desired?: boolean, forget?: AbortController): Promise<boolean> => {
      const state = { inFlight: active.current !== null, forgetting: forgetting.current !== null };
      if (!connection || (!forget && !mayStartUpdate(desired, state))) return false;
      // A tap or a Forget wins over a background refresh still in flight.
      active.current?.abort();
      // A Forget's removal owns its controller, so nothing else (a switch included) cancels it.
      const controller = forget ?? new AbortController();
      if (!forget) active.current = controller;
      if (desired !== undefined) setPending(desired);
      // A late answer, success or failure, from a computer no longer shown never touches its state.
      const stale = () => controller.signal.aborted || shown.current !== connection;
      try {
        const next = await reconcileRegistration(connection, desired, controller.signal);
        if (stale()) return false;
        setState(next);
        return true;
      } catch (cause) {
        // Only a tap reports a failed update; an unreachable Mac already shows as offline.
        if (!stale() && desired !== undefined)
          setState((old) => ({
            ...old,
            error: cause instanceof ApiError ? cause.message : SETUP_FAILED,
          }));
        return false;
      } finally {
        if (active.current === controller) active.current = null;
        if (!controller.signal.aborted) setPending(null);
      }
    },
    [connection],
  );
  const unregister = useCallback(() => {
    // A second Forget joins the removal already running instead of cancelling it.
    forgetting.current ??= removeBeforeForget(update);
    return forgetting.current;
  }, [update]);
  useEffect(() => {
    forgetting.current = null;
    void update();
    const deviceId = connection?.deviceId;
    if (deviceId)
      void turnOnByDefault(deviceId).then(async (turnOn) => {
        if (turnOn && (await update(true))) markTurnedOn(deviceId);
      });
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void update();
    });
    const stopTokens = onTokenChanged(() => void update());
    return () => {
      // Released at once, so the next computer's first refresh isn't refused as one in flight.
      active.current?.abort();
      active.current = null;
      appState.remove();
      stopTokens();
    };
  }, [update, connection?.deviceId]);
  const value: Alerts = {
    ...state,
    enabled: pending ?? state.enabled,
    busy: pending !== null,
    set: (enabled) => void update(enabled),
    unregister,
    resume: () => {
      forgetting.current = null;
      setPending(null);
      void update();
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error('NotificationProvider is missing');
  return value;
}
