import { useMemo } from 'react';
import { useFileChangeListener } from '@/lib/hooks/use-file-change-listener';
import { trpc } from '@/lib/trpc';

/**
 * A sub-chat's changed files that git still reports as uncommitted. The status card renders these,
 * and the composer dock squares its surface only when that card (or the queue card) is showing.
 * While streaming, or before git status loads, every changed file counts.
 */
export function useUncommittedFiles<File extends { displayPath: string }>(
  changedFiles: File[],
  worktreePath: string | null | undefined,
  isStreaming: boolean,
): File[] {
  // Claude's Write/Edit tools announce file changes; this invalidates the status query below.
  useFileChangeListener(worktreePath);

  const { data: gitStatus } = trpc.changes.getStatus.useQuery(
    { worktreePath: worktreePath || '', defaultBranch: 'main' },
    {
      enabled: !!worktreePath && changedFiles.length > 0 && !isStreaming,
      // No polling - updates triggered by file-changed events from Claude tools
      staleTime: 30000,
      placeholderData: (prev) => prev,
    },
  );

  return useMemo(() => {
    if (!gitStatus || !worktreePath || isStreaming) return changedFiles;
    const uncommittedPaths = new Set(
      [
        ...(gitStatus.staged ?? []),
        ...(gitStatus.unstaged ?? []),
        ...(gitStatus.untracked ?? []),
      ].map((file) => file.path),
    );
    return changedFiles.filter((file) => uncommittedPaths.has(file.displayPath));
  }, [changedFiles, gitStatus, worktreePath, isStreaming]);
}
