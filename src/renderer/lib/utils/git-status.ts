/**
 * Check whether a git status result contains any modified files
 * (staged, unstaged, or untracked).
 *
 * Used by sidebar footer, split-view pane headers, and active-chat diff sidebar
 * to show a "modified files" indicator.
 */
export function hasModifiedFiles(
  gitStatus:
    | {
        staged?: unknown[];
        unstaged?: unknown[];
        untracked?: unknown[];
      }
    | null
    | undefined,
): boolean {
  if (!gitStatus) return false;
  return (
    (gitStatus.staged?.length ?? 0) +
      (gitStatus.unstaged?.length ?? 0) +
      (gitStatus.untracked?.length ?? 0) >
    0
  );
}
