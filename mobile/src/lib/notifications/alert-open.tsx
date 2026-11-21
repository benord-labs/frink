import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { tell } from '../../ui/tell';
import { useConnection } from '../connection';
import { answerFromAlert, answersChat, lastAlertAnswer, onAlertAnswer } from './actions';
import { onNotificationOpened, setShownComputer } from './device';
import { alertedComputer, type AlertedComputer } from './routing';

type AlertOpen = { pending: AlertedComputer | null; done: (alert: AlertedComputer) => void };
const Context = createContext<AlertOpen>({ pending: null, done: () => {} });

/**
 * Turns a tapped alert into an open: an alert from another paired computer selects that computer
 * first, and the newly mounted app opens its target. Mount it only once saved computers are
 * loaded, because the alert that launched the app is consumed once.
 */
export function AlertOpenProvider({ children }: { children: ReactNode }) {
  const { computers, connection, select, request } = useConnection();
  const [pending, setPending] = useState<AlertedComputer | null>(null);
  const latest = useRef({ computers, select, request });
  latest.current = { computers, select, request };
  const shown = connection?.deviceId ?? null;
  useEffect(() => setShownComputer(shown), [shown]);
  useEffect(
    () =>
      onNotificationOpened((data, action) => {
        const { computers, select, request } = latest.current;
        const opened = alertedComputer(
          data,
          computers.map((c) => c.deviceId),
        );
        if (!opened) return;
        setPending(opened);
        select(opened.deviceId);
        void answerFromAlert(
          action,
          opened,
          computers,
          (answer, host) => request(answer, undefined, host),
          tell,
        );
      }),
    [],
  );
  return (
    // Clearing only the alert that was opened keeps a newer tap that arrived meanwhile.
    <Context.Provider
      value={{ pending, done: (alert) => setPending((now) => (now === alert ? null : now)) }}
    >
      {children}
    </Context.Provider>
  );
}

/** The tapped alert to open on the computer now shown, if any, and how to mark it opened. */
export function usePendingAlert(deviceId: string | undefined) {
  const { pending, done } = useContext(Context);
  return { alert: pending?.deviceId === deviceId ? pending : null, done };
}

/** The latest Allow or Deny from an alert that reached this chat, so its screen re-reads it. */
export function useAlertAnswer(chatId: string) {
  const answered = useSyncExternalStore(onAlertAnswer, lastAlertAnswer);
  return answersChat(answered, useConnection().connection?.deviceId, chatId) ? answered : null;
}
