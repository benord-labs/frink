/**
 * Reads a URL param from the query string, falling back to the hash params.
 *
 * The dev server passes params in the query string (`?chat=…`); a packaged `file://`
 * load can carry them in the hash (`#chat=…`). `WindowContext.getWindowId` uses the
 * same search-then-hash resolution.
 */
export function getUrlParam(key: string): string | null {
  const fromSearch = new URLSearchParams(window.location.search).get(key);
  if (fromSearch !== null) return fromSearch;
  if (window.location.hash) {
    return new URLSearchParams(window.location.hash.slice(1)).get(key);
  }
  return null;
}
