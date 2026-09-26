/**
 * Parse current working directory from terminal output.
 * Shells can report the cwd via OSC 7 escape sequences.
 */

// Regex pattern for parsing OSC 7 sequences - hoisted to module level for performance
// OSC 7 with BEL terminator: \x1b]7;file://hostname/path\x07
// OSC 7 with ST terminator: \x1b]7;file://hostname/path\x1b\\
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional for parsing terminal escape sequences
const OSC7_PATTERN_REGEX = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

/**
 * Parse OSC 7 sequences to extract current working directory.
 * Format: \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
 *
 * @param data - Terminal output data
 * @returns The parsed cwd path or null if not found
 */
export function parseCwd(data: string): string | null {
  let lastCwd: string | null = null;

  // Find all matches and return the last one (most recent)
  let match: RegExpExecArray | null = OSC7_PATTERN_REGEX.exec(data);
  while (match !== null) {
    if (match[1]) {
      try {
        lastCwd = decodeURIComponent(match[1]);
      } catch {
        // Invalid URL encoding, use as-is
        lastCwd = match[1];
      }
    }
    match = OSC7_PATTERN_REGEX.exec(data);
  }

  return lastCwd;
}
