/**
 * Extract a human-readable folder name from a file path.
 *
 * Cursor worktree paths follow the pattern:
 *   .../.cursor/worktrees/<project-name>/<worktree-id>
 * The last segment is a generated ID, not the project name.
 * This function detects that pattern and returns the project name instead.
 */
export function getDisplayFolderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  // Detect .cursor/worktrees/<project>/<id> pattern
  const worktreesIdx = segments.indexOf('worktrees');
  if (
    worktreesIdx > 0 &&
    segments[worktreesIdx - 1] === '.cursor' &&
    segments.length > worktreesIdx + 1
  ) {
    return segments[worktreesIdx + 1] ?? null;
  }
  return segments.pop() ?? null;
}
