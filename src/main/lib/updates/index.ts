// Build-time feed (MAIN_VITE_UPDATE_FEED_URL) so forks never update from Frink's (sc-3780).
// scripts/publish/assert-release-env.mjs mirrors this; its test asserts parity.
export function resolveUpdateFeedUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password) return null;

  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}
