// Keep the SPA main window on its entry: a stray file drop would otherwise navigate it to file://.
// Main-frame `will-navigate` only, so renderer iframes still navigate.
import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import log from 'electron-log';

/** The URL the main window loads: the dev server when set, else the packaged `index.html`. */
export function resolveRendererEntryUrl(
  devServerUrl: string | undefined,
  indexHtmlPath: string,
): string {
  return devServerUrl || pathToFileURL(indexHtmlPath).href;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Chromium and `pathToFileURL` may percent-encode the same path differently. */
function decodedPath(url: URL): string | null {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

/**
 * `file:` origins are all the opaque `'null'`, so a dropped file would match an origin check;
 * the packaged entry is matched on host + decoded path instead. Hash and query are ignored.
 */
export function isAllowedMainWindowNavigation(targetUrl: string, entryUrl: string): boolean {
  const target = parseUrl(targetUrl);
  const entry = parseUrl(entryUrl);
  if (!target || !entry) return false;
  if (entry.protocol !== 'file:') return target.origin === entry.origin;
  if (target.protocol !== 'file:' || target.host !== entry.host) return false;
  const targetPath = decodedPath(target);
  return targetPath !== null && targetPath === decodedPath(entry);
}

/** Scheme only — never log the path of a file the user dropped. */
function describeForLog(url: string): string {
  return parseUrl(url)?.protocol ?? 'unparseable';
}

export function attachMainWindowNavigationGuard(wc: WebContents, entryUrl: string): void {
  wc.on('will-navigate', (event, url) => {
    if (isAllowedMainWindowNavigation(url, entryUrl)) return;
    event.preventDefault();
    log.warn('[Window] Blocked main-window navigation', { scheme: describeForLog(url) });
  });
}
