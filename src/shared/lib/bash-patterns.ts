/**
 * Shared utilities for bash command pattern matching.
 * Used by both main process (command-parser) and renderer (PermissionPrompt).
 */

/** Regex to strip trailing " *" wildcard from patterns */
export const TRAILING_WILDCARD_REGEX = / \*$/;

/**
 * Convert a pattern like "git push *" or "find /path *" into human-readable description.
 */
export function getPatternDescription(pattern: string): string {
  const withoutWildcard = pattern.replace(TRAILING_WILDCARD_REGEX, '');
  const firstSpace = withoutWildcard.indexOf(' ');

  // Single word like "find *" -> "All find commands"
  if (firstSpace === -1) {
    return `All ${withoutWildcard} commands`;
  }

  const command = withoutWildcard.slice(0, firstSpace);
  const rest = withoutWildcard.slice(firstSpace + 1);

  // If rest is a simple subcommand (no paths), show "All git push commands"
  if (!rest.includes('/') && !rest.includes(' ')) {
    return `All ${command} ${rest} commands`;
  }

  // Path-based pattern -> "find in this location"
  return `${command} in this location`;
}

/** Truncate pattern for display */
export function truncatePattern(pattern: string, maxLen = 40): string {
  if (pattern.length <= maxLen) return pattern;
  return `${pattern.slice(0, maxLen)}...`;
}
