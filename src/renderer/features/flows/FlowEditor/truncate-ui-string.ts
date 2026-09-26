/** Truncate for compact UI labels (matches node summary ellipsis style). */
export function truncateUiString(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
