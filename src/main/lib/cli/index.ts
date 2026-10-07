/**
 * Launch-directory parsing for Frink
 * Handles a directory argument on cold start, e.g. `frink .` or `frink /path/to/project`
 *
 * Based on upstream PR #16 by @caffeinum (Aleksey Bykhun)
 */

import { existsSync, lstatSync } from 'node:fs';

// Launch directory from CLI (e.g., `frink /path/to/project`)
let launchDirectory: string | null = null;

/**
 * Get the launch directory passed via CLI args (consumed once)
 */
export function getLaunchDirectory(): string | null {
  const dir = launchDirectory;
  launchDirectory = null; // consume once
  return dir;
}

/**
 * Parse CLI arguments to find a directory argument
 * Called on app startup to handle `frink .` or `frink /path/to/project`
 */
export function parseLaunchDirectory(): void {
  // Look for a directory argument in argv
  // Skip electron executable and script path
  const args = process.argv.slice(process.defaultApp ? 2 : 1);

  for (const arg of args) {
    // Skip flags and protocol URLs
    if (arg.startsWith('-') || arg.includes('://')) continue;

    // Check if it's a valid directory
    if (existsSync(arg)) {
      try {
        const stat = lstatSync(arg);
        if (stat.isDirectory()) {
          launchDirectory = arg;
          return;
        }
      } catch {
        // ignore
      }
    }
  }
}
