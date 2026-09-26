import { useEffect, useState } from 'react';

/**
 * A boolean toggle persisted to localStorage.
 * Reads initial value on mount, writes on change.
 *
 * @param key - localStorage key. Must be a static string literal — changing
 *   the key after mount is **not** supported (the initial value won't re-read).
 * @param defaultValue - fallback if key is absent (default: false)
 */
export function usePersistedToggle(
  key: string,
  defaultValue = false,
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? stored === 'true' : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {
      // biome-ignore lint/suspicious/noConsole: intentional warning for storage failures
      console.warn(`[localStorage] Failed to persist ${key}:`, e);
    }
  }, [key, value]);

  return [value, setValue];
}
