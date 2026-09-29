import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import type { MobileAgentCounts } from '@frink/shared/types/remote/mobile';
import type { Connection } from '../api';
import { useConnection } from '../connection';
import { useOverview } from '../overview';
import { endSession, reconcile, type Session } from './reconcile';

type LockScreen = { on: boolean; refused: boolean; set: (on: boolean) => void };
const Context = createContext<LockScreen | null>(null);

const KEY = 'frink.mobile.live-activity.v1';
// iPad has no Lock Screen card layout, so it never offers one.
const SUPPORTED = !(Platform.OS === 'ios' && Platform.isPad);

/** The switch is off until turned on; a switch that fails to save is off again after a restart. */
function readSwitch() {
  return SecureStore.getItemAsync(KEY).then((saved) => saved === 'on', () => false);
}
function saveSwitch(on: boolean) {
  SecureStore.setItemAsync(KEY, on ? 'on' : 'off').catch(() => undefined);
}

function refresh(
  session: Session,
  host: Connection | null,
  on: boolean | undefined,
  agents: MobileAgentCounts | undefined,
  setRefused: (refused: boolean) => void,
) {
  if (!SUPPORTED || !host || on === undefined) return;
  reconcile(session, host, on, agents)
    .then((refused) => refused !== undefined && setRefused(refused))
    .catch(() => undefined);
}

/**
 * Runs `refresh` on open, on return to the app, on a switch change, and whenever the overview's
 * counts change while Frink is open. Unmounting means the Mac was forgotten or replaced (the app
 * remounts per pairing), so the session ends with the last Mac it talked to.
 */
function useReconcile(on: boolean | undefined, setRefused: (refused: boolean) => void) {
  const { connection } = useConnection();
  const agents = useOverview().data?.agents;
  const session = useRef<Session>({ sent: null }).current;
  const last = useRef(connection);
  last.current = connection;
  useEffect(() => () => void (SUPPORTED && endSession(session, last.current)), [session]);
  const run = useCallback(
    () => refresh(session, connection, on, agents, setRefused),
    // Counts, not the object: the overview poll returns a new one every few seconds.
    [session, connection, on, agents?.running, agents?.needsYou, setRefused],
  );
  useEffect(() => {
    run();
    const listener = AppState.addEventListener('change', (next) => next === 'active' && run());
    return () => listener.remove();
  }, [run]);
}

/** Keeps the Lock Screen card in line with its switch and the Mac's counts. */
export function LiveActivityProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState<boolean>();
  const [refused, setRefused] = useState(false);
  useEffect(() => void readSwitch().then(setOn), []);
  useReconcile(on, setRefused);
  const set = (value: boolean) => {
    setOn(value);
    saveSwitch(value);
  };
  const value = SUPPORTED && on !== undefined ? { on, refused, set } : null;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The Lock Screen switch, or null where there is no card to offer (iPad, browser previews). */
export function useLiveActivity() {
  return useContext(Context);
}
