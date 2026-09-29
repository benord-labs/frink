import { requestNotifications, type Connection } from '../api';
import * as device from './device';

export type AlertState = { enabled: boolean; denied: boolean; error: string | null };

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
  signal.throwIfAborted();
  if (turnOn && allowed) {
    const token = await device.pushToken();
    signal.throwIfAborted();
    await requestNotifications(host, { token }, signal);
    return { enabled: true, denied: false, error };
  }
  if (status.enabled) await requestNotifications(host, { token: null }, signal);
  return { enabled: false, denied: turnOn && !allowed, error };
}
