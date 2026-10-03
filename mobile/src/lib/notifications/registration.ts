import { requestNotifications, type Connection } from '../api';
import * as device from './device';

export type AlertState = { enabled: boolean; denied: boolean; error: string | null };

// React Native's AbortSignal (the abort-controller polyfill) has no throwIfAborted().
function stopIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Alert update cancelled.');
}

/**
 * Whether a refresh or a tap may start an alert update. A refresh (`desired` undefined) waits for
 * any update in flight. Nothing starts while the Mac is being forgotten: a turn-on would
 * re-register alerts for a Mac this iPhone is about to drop, and any update would cancel the
 * forget's own removal.
 */
export function mayStartUpdate(
  desired: boolean | undefined,
  { inFlight, forgetting }: { inFlight: boolean; forgetting: boolean },
): boolean {
  if (forgetting) return false;
  return !(inFlight && desired === undefined);
}

/**
 * Brings the Mac's registration for this iPhone in line with `desired` (a tap on the switch) or,
 * when undefined, with what the Mac already has — re-sending a rotated token, or removing the
 * registration once alerts are blocked in iPhone Settings. Only an explicit turn-on asks iOS.
 */
export async function reconcileRegistration(
  host: Connection,
  desired: boolean | undefined,
  signal: AbortSignal,
): Promise<AlertState> {
  const status = await requestNotifications(host, {}, signal);
  // A delivery failure the Mac saw is shown on a refresh; any tap on the switch clears it there.
  const error = desired === undefined ? status.error : null;
  const turnOn = desired ?? status.enabled;
  const allowed = await device.permission(desired === true);
  stopIfAborted(signal);
  if (turnOn && allowed) {
    const token = await device.pushToken();
    stopIfAborted(signal);
    await requestNotifications(host, { token }, signal);
    return { enabled: true, denied: false, error };
  }
  if (status.enabled) await requestNotifications(host, { token: null }, signal);
  return { enabled: false, denied: turnOn && !allowed, error };
}
