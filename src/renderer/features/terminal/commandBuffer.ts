/**
 * Utilities for managing command buffer and extracting tab titles.
 */

/**
 * Sanitize a command string for use as a tab title.
 * Removes control characters, trims whitespace, and limits length.
 *
 * @param command - The raw command buffer contents
 * @returns A sanitized string suitable for use as a tab title
 */
export function sanitizeForTitle(command: string): string {
  if (!command) return '';

  // Remove ANSI escape sequences
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional for parsing ANSI escape sequences
  let cleaned = command.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Remove other control characters
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional for removing control characters
  cleaned = cleaned.replace(/[\x00-\x1f\x7f]/g, '');

  // Trim and limit length
  cleaned = cleaned.trim();

  if (cleaned.length > 50) {
    cleaned = `${cleaned.slice(0, 47)}...`;
  }

  return cleaned;
}
