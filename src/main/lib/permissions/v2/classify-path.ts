/**
 * Classify a file path as inside the current project or outside.
 *
 * Used by file-op checkers to drive the renderer's 3-button file-op flow:
 * in-project paths can receive a tool-wide project-scope rule; outside paths
 * get only Deny / Allow once.
 *
 * Reuses `isPathWithinProject` (`src/main/lib/permissions/path-check.ts`) which
 * already handles `fs.realpathSync` and the ENOENT fallback case. This wrapper
 * exists so file-op checkers branch on a two-state value instead of inlining
 * the boolean check + adding `PathLocation` strings ad hoc.
 *
 * Ticket 15 of the permissions overhaul.
 */

import type { PathLocation } from '../../../../shared/types/permissions';
import { isPathWithinProject } from '../path-check';

export type { PathLocation };

export function classifyPath(filePath: string, projectRoot: string): PathLocation {
  if (!projectRoot) return 'outside';
  return isPathWithinProject(filePath, projectRoot) ? 'in-current-project' : 'outside';
}
