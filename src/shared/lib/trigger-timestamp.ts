export const UNKNOWN_TRIGGER_TIMESTAMP = 'unknown';

/** ISO-like UTC string; identical on all hosts (no locale). */
function formatUtcDeterministic(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${min}:${s}.${ms} UTC`;
}

export function formatTriggerTimestamp(value?: string): string {
  const rawValue = value?.trim();
  const normalized = rawValue?.toLowerCase() ?? '';
  if (!rawValue || normalized === UNKNOWN_TRIGGER_TIMESTAMP) {
    return 'Unknown';
  }

  const parsed = new Date(rawValue);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return formatUtcDeterministic(parsed);
}
