/**
 * Time formatting utilities
 */

import { formatDistanceToNow } from 'date-fns';

/**
 * Formats a date to a short relative time string
 * Example: "2 hours ago" → "2h", "less than a minute" → "<1m"
 */
export function formatShortTimeAgo(date: Date): string {
  const timeAgo = formatDistanceToNow(date, { addSuffix: false });

  return timeAgo
    .replace('less than a minute', '<1m')
    .replace('about ', '')
    .replace('over ', '>')
    .replace('almost ', '~')
    .replace(' minutes', 'm')
    .replace(' minute', 'm')
    .replace(' hours', 'h')
    .replace(' hour', 'h')
    .replace(' days', 'd')
    .replace(' day', 'd')
    .replace(' months', 'mo')
    .replace(' month', 'mo')
    .replace(' years', 'y')
    .replace(' year', 'y');
}

/**
 * Formats an ISO date string to a human-readable relative time ("ago" / "in …").
 * Falls back to a localized date string when the offset is 7+ days (past or future).
 * Example: "Just now", "5m ago", "2h ago", "3d ago", "in 1h", "Mar 15, 2026"
 */
export function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso);
    const t = date.getTime();
    if (Number.isNaN(t)) return iso;

    const diffMs = Date.now() - t;

    if (diffMs < 0) {
      const absSec = Math.floor(Math.abs(diffMs) / 1000);
      if (absSec < 60) return 'in <1m';
      const diffMin = Math.floor(absSec / 60);
      if (diffMin < 60) return `in ${diffMin}m`;
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return `in ${diffHrs}h`;
      const diffDays = Math.floor(diffHrs / 24);
      if (diffDays < 7) return `in ${diffDays}d`;
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
    }

    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  } catch {
    return iso;
  }
}

/** A local calendar day (`2026-08-29`) as `29 Aug`, or `Sat, 29 Aug` with the weekday, in the
 * viewer's locale. */
export function formatDayLabel(day: string, withWeekday = false): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    weekday: withWeekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
  });
}
