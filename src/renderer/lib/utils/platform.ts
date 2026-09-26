/**
 * Platform detection utilities for Agents Desktop
 *
 * Detects whether the app is running in Electron desktop app
 * and provides platform-specific shortcuts
 */

/**
 * Check if running inside Electron desktop app
 */
export function isDesktopApp(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.desktopApi;
}

/**
 * Get the current platform
 */
function getPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  if (typeof window !== 'undefined' && window.desktopApi?.platform) {
    return window.desktopApi.platform as 'darwin' | 'win32' | 'linux';
  }
  return 'unknown';
}

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return getPlatform() === 'darwin';
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/**
 * Get the platform-specific file manager name for "Reveal in ..." labels.
 * macOS → Finder, Windows → Explorer, Linux → Files
 */
export function getFileManagerName(): string {
  if (isMacOS()) return 'Finder';
  if (isWindows()) return 'Explorer';
  return 'Files';
}

/**
 * Get a platform-aware "Reveal in Finder" label.
 * Optionally pass a count for batch selection labels.
 */
export function getRevealLabel(count?: number): string {
  const app = getFileManagerName();
  return count && count > 1 ? `Reveal ${count} in ${app}` : `Reveal in ${app}`;
}
