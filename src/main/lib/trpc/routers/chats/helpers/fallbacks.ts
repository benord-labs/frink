/**
 * Fallback utilities for chat name generation
 */

/**
 * Generate fallback chat name from user message
 * Truncates to 80 characters if longer (sidebar handles visual truncation via CSS)
 */
export function getFallbackName(userMessage: string): string {
  const trimmed = userMessage.trim();
  if (trimmed.length <= 100) {
    return trimmed || 'New Chat';
  }
  return `${trimmed.substring(0, 100)}...`;
}
