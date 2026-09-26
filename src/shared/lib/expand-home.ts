import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

/**
 * Expand `~` / `~/...` to the user's home directory. Returns input unchanged
 * for non-tilde paths. Pure — no I/O.
 */
export function expandHomePath(inputPath: string): string {
  if (inputPath === '~') {
    return nodeOs.homedir();
  }
  // Accept both `~/` (POSIX) and `~\` (Windows) — display paths are built with the OS separator.
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return nodePath.join(nodeOs.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
