/** Normalize renderer-visible Flow metadata without carrying control characters into the DOM. */
export function normalizeFlowChangeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return fallback;
  return normalized.length > 96 ? `${normalized.slice(0, 95).trimEnd()}…` : normalized;
}

/** Preserve a non-empty Flow identifier exactly as supplied. */
export function flowChangeStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
