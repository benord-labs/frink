import {
  isRootLikePath,
  normalizePathSlashes,
  trimTrailingSlashes,
} from '../../../shared/lib/path-normalization';

/**
 * Regex to match worktree paths: .frink/worktrees/{segment}/{segment}/relativePath
 * Supports both legacy ({projectId}/{chatId}) and new ({projectSlug}/{landscapeName}) formats.
 * Captures the relative path after the second segment directory.
 */
const WORKTREE_PATH_REGEX = /\.frink\/worktrees\/[^/]+\/[^/]+\/(.+)$/;

/**
 * Extract the relative file path from a worktree absolute path.
 * Returns the path portion after `.frink/worktrees/{segment}/{segment}/`, or null if not a worktree path.
 */
export function extractWorktreeRelativePath(
  filePath: string,
  worktreeBasePath?: string | null,
): string | null {
  const normalizedPath = normalizePathSlashes(filePath);

  if (worktreeBasePath) {
    const normalizedBase = trimTrailingSlashes(normalizePathSlashes(worktreeBasePath));
    if (!isRootLikePath(normalizedBase) && normalizedPath.startsWith(`${normalizedBase}/`)) {
      const relativeToBase = normalizedPath.slice(normalizedBase.length + 1);
      const segments = relativeToBase.split('/');
      if (segments.length >= 3) {
        return segments.slice(2).join('/');
      }
    }
  }

  const match = normalizedPath.match(WORKTREE_PATH_REGEX);
  return match ? match[1] : null;
}
