import log from 'electron-log';
import type { MobileAgentCounts } from '../../../../shared/types/remote/mobile';
import type { MobilePairingStore } from '../pairing-store';
import { readAgentCounts } from './counts';

/** Set after deploying live-activity-forwarder; forks point it at their own deployment. */
export const LIVE_ACTIVITY_URL =
  'https://REPLACE-WITH-DEPLOYED-FORWARDER.workers.dev/live-activity';

const TICK_MS = 5_000;
const FLOOR_MS = 10_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const END_AFTER_MS = 60_000;
// Well inside the 30 minute stale date the forwarder sets, so a live Mac never looks stale.
const KEEP_ALIVE_MS = 15 * 60_000;

export type LiveActivityPush = MobileAgentCounts & {
  token: string;
  event: 'update' | 'end';
  urgent: boolean;
};
type SendResult = 'ok' | 'gone' | 'retry';
type LiveActivityStore = Pick<MobilePairingStore, 'liveActivityRecipients' | 'liveActivityGone'>;
type DeviceState = {
  token: string;
  lastSent?: MobileAgentCounts & { at: number };
  candidate: { value: MobileAgentCounts; since: number };
  zeroSince?: number;
  nextAllowedAt: number;
  backoffMs: number;
};

export async function postToForwarder(
  { token, event, running, needsYou, urgent }: LiveActivityPush,
  timeoutMs = 10_000,
): Promise<SendResult> {
  try {
    const response = await fetch(LIVE_ACTIVITY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, event, running, needsYou, urgent }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return 'ok';
    if (response.status === 410) return 'gone';
    log.warn(`[Mobile] Live Activity update failed with status ${response.status}.`);
  } catch {
    log.warn('[Mobile] Live Activity update could not reach the forwarder.');
  }
  return 'retry';
}

const same = (a: MobileAgentCounts, b: MobileAgentCounts) =>
  a.running === b.running && a.needsYou === b.needsYou;

/** The update this device is owed now, if any. The Mac is the card's only writer. */
function due(state: DeviceState, counts: MobileAgentCounts, now: number) {
  // Half a tick of slack, so timer jitter never pushes a send to the tick after.
  if (now + TICK_MS / 2 < state.nextAllowedAt) return null;
  const { lastSent, candidate } = state;
  if (!lastSent) return { event: 'update' as const, urgent: counts.needsYou > 0 };
  if (state.zeroSince !== undefined && now - state.zeroSince >= END_AFTER_MS)
    return { event: 'end' as const, urgent: false };
  if (same(counts, lastSent))
    return now - lastSent.at >= KEEP_ALIVE_MS ? { event: 'update' as const, urgent: false } : null;
  // A value must hold for two ticks, so a blip between them never reaches the phone.
  if (candidate.since < now)
    return { event: 'update' as const, urgent: counts.needsYou > lastSent.needsYou };
  return null;
}

/** Keeps each phone's Lock Screen card in step with the Mac's agent counts. */
export function startMobileLiveActivity(
  store: LiveActivityStore,
  send: (push: LiveActivityPush, timeoutMs?: number) => Promise<SendResult> = postToForwarder,
) {
  const devices = new Map<string, DeviceState>();
  // Cards ended while a tick was reading counts, so that tick skips them.
  const ended = new Set<string>();
  let stopped = false;
  let busy = false;

  // Ending never waits: quitting or turning access off must not be held up by the network.
  function end(token: string) {
    void send({ token, event: 'end', running: 0, needsYou: 0, urgent: false }, 1_000);
  }

  async function forget(id: string, token: string) {
    devices.delete(id);
    await store.liveActivityGone(id, token);
  }

  async function deliver(id: string, state: DeviceState, counts: MobileAgentCounts, now: number) {
    const push = due(state, counts, now);
    if (!push) return;
    const result = await send({ token: state.token, ...counts, ...push });
    if (push.event === 'end' || result === 'gone') return forget(id, state.token);
    state.backoffMs = result === 'ok' ? FLOOR_MS : Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
    state.nextAllowedAt = now + state.backoffMs;
    if (result === 'ok') state.lastSent = { ...counts, at: now };
  }

  async function tick() {
    const now = Date.now();
    const recipients = store.liveActivityRecipients();
    // A replaced token is a new card, so it starts from scratch.
    for (const [id, state] of devices)
      if (!recipients.some((entry) => entry.id === id && entry.token === state.token))
        devices.delete(id);
    if (!recipients.length) return;
    const counts = await readAgentCounts();
    if (stopped) return;
    const live = recipients.filter(({ id }) => !ended.has(id));
    ended.clear();
    await Promise.all(
      live.map(({ id, token }) => {
        const candidate = { value: counts, since: now };
        const state = devices.get(id) ?? { token, candidate, nextAllowedAt: 0, backoffMs: FLOOR_MS };
        devices.set(id, state);
        if (!same(state.candidate.value, counts)) state.candidate = candidate;
        state.zeroSince = counts.running + counts.needsYou ? undefined : (state.zeroSince ?? now);
        return deliver(id, state, counts, now);
      }),
    );
  }

  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick()
      .catch(() => log.warn('[Mobile] Could not update the Live Activity.'))
      .finally(() => {
        busy = false;
      });
  }, TICK_MS);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const { token } of devices.values()) end(token);
      devices.clear();
    },
    endDevice(id: string) {
      ended.add(id);
      const state = devices.get(id);
      if (!state) return;
      devices.delete(id);
      end(state.token);
    },
  };
}
