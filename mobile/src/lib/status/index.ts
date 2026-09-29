import type { MobileActivity } from '../../../../src/shared/types/remote/mobile';

/** Shape-coded, so a state never rests on colour alone (desktop FlowStatusGlyph's set). */
export type StatusGlyph =
  | 'never'
  | 'live'
  | 'queued'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'awaiting'
  | 'failed'
  | 'background';
/** `live` is green, `accent` is Frink primary, `attention` amber, `danger` red; the rest is muted. */
export type StatusTone = 'quiet' | 'live' | 'accent' | 'attention' | 'danger';
export type Status = { word: string; tone: StatusTone; glyph: StatusGlyph };

const QUIET_DONE: Status = { word: 'Done', tone: 'quiet', glyph: 'done' };

/** Flow runs and their steps, in the desktop Flows list's words and colours: a live run is green,
 *  a wait on you amber, a failure red, and everything else stays muted. */
const RUN: Record<string, Status> = {
  running: { word: 'Running', tone: 'live', glyph: 'live' },
  pending: { word: 'Starting', tone: 'live', glyph: 'live' },
  queued: { word: 'Queued', tone: 'quiet', glyph: 'queued' },
  awaiting_input: { word: 'Waiting for you', tone: 'attention', glyph: 'awaiting' },
  paused: { word: 'Paused', tone: 'quiet', glyph: 'paused' },
  failed: { word: 'Failed', tone: 'danger', glyph: 'failed' },
  cancelled: { word: 'Cancelled', tone: 'quiet', glyph: 'cancelled' },
  completed: QUIET_DONE,
  succeeded: QUIET_DONE,
  skipped: { word: 'Skipped', tone: 'quiet', glyph: 'cancelled' },
};

export function runStatus(status: string | null | undefined): Status {
  if (!status) return { word: 'Never run', tone: 'quiet', glyph: 'never' };
  return RUN[status] ?? { word: humanize(status), tone: 'quiet', glyph: 'never' };
}

/** Work Queue tasks, using the desktop attention carousel's labels. */
const TASK: Record<string, Status> = {
  running: { word: 'Running', tone: 'live', glyph: 'live' },
  pending: { word: 'Up next', tone: 'quiet', glyph: 'queued' },
  plan_ready: { word: 'Plan ready', tone: 'accent', glyph: 'awaiting' },
  needs_attention: { word: 'Needs you', tone: 'attention', glyph: 'awaiting' },
  awaiting_input: { word: 'Needs your answer', tone: 'attention', glyph: 'awaiting' },
  interrupted: { word: 'Interrupted', tone: 'attention', glyph: 'paused' },
  failed: { word: 'Failed', tone: 'danger', glyph: 'failed' },
  done: { word: 'Ready for review', tone: 'accent', glyph: 'done' },
  completed: QUIET_DONE,
  cancelled: { word: 'Cancelled', tone: 'quiet', glyph: 'cancelled' },
};

export function taskStatus(status: string): Status {
  return TASK[status] ?? { word: humanize(status), tone: 'quiet', glyph: 'never' };
}

/** A chat's live state, as the desktop sidebar shows it: running pulses in primary, while a turn
 *  parked on background work is a static "Background" that does not count as running. */
export function activityStatus(activity: MobileActivity): Status | null {
  if (activity === 'running') return { word: 'Running', tone: 'accent', glyph: 'live' };
  if (activity === 'background') return { word: 'Background', tone: 'accent', glyph: 'background' };
  return null;
}

export function humanize(status: string): string {
  const words = status.replaceAll('_', ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** "now", "5m", "3h", "2d", then a short date; compact enough for a row's right-hand slot. */
export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < 60 * MINUTE) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / (60 * MINUTE))}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "42s", "3m 12s", "1h 4m": how long something has been running or took. */
export function duration(fromIso: string | null | undefined, toMs: number): string {
  if (!fromIso) return '';
  const seconds = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 1000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type DateBucket = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

/** Chats list sections, by the local calendar day of the last activity. */
export function dateBucket(iso: string, now = new Date()): DateBucket {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = Date.parse(iso);
  if (time >= startOfToday) return 'Today';
  if (time >= startOfToday - DAY) return 'Yesterday';
  if (time >= startOfToday - 7 * DAY) return 'Previous 7 days';
  return 'Older';
}
