import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { getWindowId } from '../contexts/WindowContext';

/**
 * Track which keys have been migrated to avoid repeated migration attempts.
 * Per-session cache - once a key is checked, we don't check again.
 */
const migratedKeys = new Set<string>();

/**
 * Creates a storage adapter that prefixes localStorage keys with window ID.
 * This allows each Electron window to have its own isolated storage namespace.
 *
 * On first read, if the window-scoped key doesn't exist but the legacy key does,
 * it migrates the data to the window-scoped key.
 */
function createWindowScopedStorage<T>() {
  return createJSONStorage<T>(() => ({
    getItem: (key: string) => {
      const windowKey = `${getWindowId()}:${key}`;
      let value = localStorage.getItem(windowKey);

      // Only attempt migration if value not found and not already migrated
      if (value === null && !migratedKeys.has(windowKey)) {
        // Check legacy key (without any window prefix)
        const legacyValue = localStorage.getItem(key);
        if (legacyValue !== null) {
          try {
            localStorage.setItem(windowKey, legacyValue);
          } catch (e) {
            // biome-ignore lint/suspicious/noConsole: migration warning is useful for debugging storage issues
            console.warn(`[WindowStorage] Failed to save migrated value for ${windowKey}:`, e);
          }
          value = legacyValue;
        }
        migratedKeys.add(windowKey);
      }

      return value;
    },
    setItem: (key: string, value: string) => {
      const windowKey = `${getWindowId()}:${key}`;
      try {
        localStorage.setItem(windowKey, value);
      } catch (e) {
        // biome-ignore lint/suspicious/noConsole: storage error logging is needed for debugging
        console.error(`[WindowStorage] Failed to save ${windowKey}:`, e);
      }
    },
    removeItem: (key: string) => {
      const windowKey = `${getWindowId()}:${key}`;
      localStorage.removeItem(windowKey);
    },
  }));
}

/**
 * Atom with storage that is scoped to the current window.
 * Each Electron window has its own isolated storage namespace.
 *
 * Use this for state that should be different per window, like:
 * - Selected chat ID
 * - Selected project
 * - Sidebar open/close states
 *
 * For shared preferences (sidebar width, model settings, etc.),
 * use the regular atomWithStorage instead.
 */
export function atomWithWindowStorage<T>(
  key: string,
  initialValue: T,
  options?: { getOnInit?: boolean },
) {
  return atomWithStorage<T>(key, initialValue, createWindowScopedStorage<T>(), options);
}
