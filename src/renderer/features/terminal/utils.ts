/**
 * Terminal utility functions.
 */

// Pattern for characters that need shell escaping
const SPECIAL_CHARS_PATTERN = /[\s'"\\$`!]/;

/**
 * Escape file paths for shell usage.
 * Wraps paths containing spaces in quotes.
 *
 * @param paths - Array of file paths
 * @returns Space-separated string of escaped paths
 */
export function shellEscapePaths(paths: string[]): string {
  return paths
    .map((p) => {
      // If path contains spaces, special chars, or is empty, quote it
      if (!p || SPECIAL_CHARS_PATTERN.test(p)) {
        // Escape shell-special chars that still expand inside double quotes.
        return `"${p.replace(/["\\$`!]/g, '\\$&')}"`;
      }
      return p;
    })
    .join(' ');
}

/**
 * Debounce a function call.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function with cancel method
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): T & { cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}
