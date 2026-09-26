import { useAtom } from 'jotai';
import { useCallback } from 'react';
import { splitPaneFileTreesAtom } from '../../../features/files-sidebar/atoms';
import { trpc } from '../../../lib/trpc';
import { hasModifiedFiles } from '../../../lib/utils/git-status';

type UseFileTreeToggleOptions = {
  /** 0-based pane index in split view. undefined = not in split view. */
  splitPaneIndex?: number;
  /** Project path — needed for git status query. */
  projectPath?: string;
};

type UseFileTreeToggleResult = {
  isInSplitView: boolean;
  hasProject: boolean;
  fileTreeOpen: boolean;
  modifiedFiles: boolean;
  toggleFileTree: () => void;
};

/**
 * Shared hook for split-pane file tree toggle state + git status indicator.
 * Used by ChatHeader (active chat), NewChatFormHeader (new chat).
 */
export function useFileTreeToggle({
  splitPaneIndex,
  projectPath,
}: UseFileTreeToggleOptions): UseFileTreeToggleResult {
  const isInSplitView = splitPaneIndex !== undefined;
  const hasProject = !!projectPath;

  const [openFileTrees, setOpenFileTrees] = useAtom(splitPaneFileTreesAtom);
  const fileTreeOpen = isInSplitView && openFileTrees.has(splitPaneIndex);

  const toggleFileTree = useCallback(() => {
    if (splitPaneIndex === undefined) return;
    setOpenFileTrees((prev: Set<number>) => {
      const next = new Set(prev);
      if (next.has(splitPaneIndex)) next.delete(splitPaneIndex);
      else next.add(splitPaneIndex);
      return next;
    });
  }, [splitPaneIndex, setOpenFileTrees]);

  const { data: gitStatus } = trpc.changes.getStatus.useQuery(
    { worktreePath: projectPath || '' },
    { enabled: isInSplitView && hasProject },
  );
  const modifiedFiles = gitStatus ? hasModifiedFiles(gitStatus) : false;

  return { isInSplitView, hasProject, fileTreeOpen, modifiedFiles, toggleFileTree };
}
