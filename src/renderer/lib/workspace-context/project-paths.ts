/**
 * Which registered project a path lies in. Containment is by the path as written: a symlinked or
 * differently cased checkout matches nothing, so it stays unopened rather than opening wrong.
 */
import {
  isRootLikePath,
  isWindowsAbsolutePath,
  normalizePathForComparison,
} from '../../../shared/lib/path-normalization';

/** True for a project with a folder on disk; a `virtual://` project only groups chats. */
export function isRealProjectPath(projectPath: string | null | undefined): projectPath is string {
  return !!projectPath && !projectPath.startsWith('virtual://');
}

/** Both paths in normalizePathForComparison form: `path` is `folder` itself or lies inside it. */
function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The project a full path lies in. The longest folder wins, so a nested project beats the one
 *  around it; virtual and root-like folders hold nothing, and a relative path lies in none. */
export function findProjectForPath<T extends { path: string }>(
  filePath: string,
  projects: readonly T[],
): T | null {
  if (!filePath.startsWith('/') && !isWindowsAbsolutePath(filePath)) return null;
  const file = normalizePathForComparison(filePath) ?? '';
  let found: T | null = null;
  let foundLength = -1;
  for (const project of projects) {
    if (!isRealProjectPath(project.path) || isRootLikePath(project.path)) continue;
    const folder = normalizePathForComparison(project.path) ?? '';
    if (folder.length > foundLength && isWithin(file, folder)) {
      found = project;
      foundLength = folder.length;
    }
  }
  return found;
}

/** True when two folders are the same or one lies inside the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = normalizePathForComparison(a) ?? '';
  const right = normalizePathForComparison(b) ?? '';
  return isWithin(left, right) || isWithin(right, left);
}
