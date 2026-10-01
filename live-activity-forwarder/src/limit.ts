import type { Push } from './apns';

// Best effort and per isolate: the Mac's own send floor is the real throttle. This only bounds
// what one isolate will pass on to APNs if someone sprays it.
const TOKEN_GAP_MS = 5_000;
const TOKEN_HOURLY = 60;
const GLOBAL_PER_MINUTE = 300;
const MAX_TRACKED_TOKENS = 10_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Window = { start: number; count: number };

const tokens = new Map<string, Window & { last: number }>();
let global: Window = { start: 0, count: 0 };

const secondsUntil = (at: number, now: number) => Math.ceil((at - now) / 1000);

/**
 * 0 when the push may go ahead, otherwise the seconds to wait. An `end` skips the per-token gap:
 * the Mac sends it once, without retrying, often right after a final update.
 */
export function retryAfter(token: string, event: Push['event'], now = Date.now()): number {
  if (now - global.start >= MINUTE_MS) global = { start: now, count: 0 };
  if (global.count >= GLOBAL_PER_MINUTE) return secondsUntil(global.start + MINUTE_MS, now);
  if (tokens.size >= MAX_TRACKED_TOKENS) tokens.clear();
  let entry = tokens.get(token);
  if (entry && event !== 'end' && now - entry.last < TOKEN_GAP_MS)
    return secondsUntil(entry.last + TOKEN_GAP_MS, now);
  if (!entry || now - entry.start >= HOUR_MS) entry = { start: now, count: 0, last: 0 };
  if (entry.count >= TOKEN_HOURLY) return secondsUntil(entry.start + HOUR_MS, now);
  tokens.set(token, { ...entry, count: entry.count + 1, last: now });
  global.count += 1;
  return 0;
}
