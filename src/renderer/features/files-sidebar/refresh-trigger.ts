/**
 * Global refresh trigger for file tree
 * When a file is saved, we emit a custom event that the file tree listens for
 */

import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';

export const FILE_TREE_REFRESH_EVENT = 'file-tree-refresh';
export const FILE_TREE_REVEAL_EVENT = 'file-tree-reveal';

type FileTreeRefreshEventDetail = {
  projectPath: string;
  force?: boolean;
};

type FileTreeRevealEventDetail = {
  projectPath: string;
  folderPath: string;
};

export function triggerFileTreeRefresh(projectPath: string, options?: { force?: boolean }): void {
  window.dispatchEvent(
    new CustomEvent<FileTreeRefreshEventDetail>(FILE_TREE_REFRESH_EVENT, {
      detail: { projectPath, force: options?.force },
    }),
  );
}

export function triggerFileTreeReveal(projectPath: string, folderPath: string): void {
  window.dispatchEvent(
    new CustomEvent<FileTreeRevealEventDetail>(FILE_TREE_REVEAL_EVENT, {
      detail: { projectPath, folderPath },
    }),
  );
}

/** Shared impl for invalidating list + search and bumping refresh trigger (used by FilesSidebar and PaneFileTree). */
export function invalidateFileTreeQueries(
  utils: {
    files: { listDirectory: { invalidate: () => void }; search: { invalidate: () => void } };
  },
  setRefreshTrigger: (updater: (prev: number) => number) => void,
): void {
  utils.files.listDirectory.invalidate();
  utils.files.search.invalidate();
  setRefreshTrigger((prev) => prev + 1);
}

const REFETCH_THROTTLE_MS = 500; // Minimum time between refetches

type UseFileTreeRefreshListenersArgs = {
  /** Resolved project path this tree is scoped to; listeners are inert while it's falsy. */
  projectPath: string | null | undefined;
};

type UseFileTreeRefreshListenersResult = {
  /** Bumped on every git-status-change / refresh event; feed it to <RefreshContext.Provider>. */
  refreshTrigger: number;
  setRefreshTrigger: Dispatch<SetStateAction<number>>;
  /** Folder to expand after a drop/reveal; auto-clears one paint after being set. */
  pathToExpandAfterDrop: string | null;
  setPathToExpandAfterDrop: Dispatch<SetStateAction<string | null>>;
};

/** File-tree refresh/reveal state and listeners shared by FilesSidebar and PaneFileTree: git
 * status and refresh events bump the trigger; reveal events expand the drop folder. */
export function useFileTreeRefreshListeners({
  projectPath,
}: UseFileTreeRefreshListenersArgs): UseFileTreeRefreshListenersResult {
  const utils = trpc.useUtils();
  const lastRefetchTime = useRef(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [pathToExpandAfterDrop, setPathToExpandAfterDrop] = useState<string | null>(null);

  // Clear expand-after-drop so we don't keep re-expanding; give TreeNodes one paint to react
  useEffect(() => {
    if (pathToExpandAfterDrop == null) return;
    const t = setTimeout(() => setPathToExpandAfterDrop(null), 0);
    return () => clearTimeout(t);
  }, [pathToExpandAfterDrop]);

  // Listen for file changes (git operations and file edits)
  useEffect(() => {
    if (!window.desktopApi || !projectPath) return;

    const cleanup = window.desktopApi.onGitStatusChanged((data) => {
      if (data.worktreePath === projectPath) {
        utils.files.listDirectory.invalidate();
        utils.files.search.invalidate();
        utils.files.searchContent.invalidate();
        // Trigger tree nodes to refetch their children
        setRefreshTrigger((prev) => prev + 1);
      }
    });

    // Subscribe to git watcher for this project
    window.desktopApi.subscribeToGitWatcher(projectPath);

    return () => {
      cleanup();
      window.desktopApi.unsubscribeFromGitWatcher(projectPath).catch(() => {});
    };
  }, [projectPath, utils, setRefreshTrigger]);

  // Listen for file tree refresh events (from file saves)
  useEffect(() => {
    if (!projectPath) return;

    const handleRefresh = (event: Event) => {
      // SAFETY: only FILE_TREE_REFRESH_EVENT dispatches carry this detail shape.
      const customEvent = event as CustomEvent<FileTreeRefreshEventDetail>;
      if (customEvent.detail.projectPath === projectPath) {
        // Throttle refetches
        const now = Date.now();
        if (!customEvent.detail.force && now - lastRefetchTime.current < REFETCH_THROTTLE_MS) {
          return;
        }
        lastRefetchTime.current = now;
        utils.files.listDirectory.invalidate();
        utils.files.search.invalidate();
        utils.files.searchContent.invalidate();
        // Trigger tree nodes to refetch their children
        setRefreshTrigger((prev) => prev + 1);
      }
    };

    window.addEventListener(FILE_TREE_REFRESH_EVENT, handleRefresh);

    return () => {
      window.removeEventListener(FILE_TREE_REFRESH_EVENT, handleRefresh);
    };
  }, [projectPath, utils, setRefreshTrigger]);

  // Listen for reveal-after-drop events so the destination folder expands
  useEffect(() => {
    if (!projectPath) return;

    const handleReveal = (event: Event) => {
      // SAFETY: only FILE_TREE_REVEAL_EVENT dispatches carry this detail shape.
      const customEvent = event as CustomEvent<FileTreeRevealEventDetail>;
      if (customEvent.detail.projectPath !== projectPath) return;
      setPathToExpandAfterDrop(customEvent.detail.folderPath);
    };

    window.addEventListener(FILE_TREE_REVEAL_EVENT, handleReveal);
    return () => window.removeEventListener(FILE_TREE_REVEAL_EVENT, handleReveal);
  }, [projectPath, setPathToExpandAfterDrop]);

  return { refreshTrigger, setRefreshTrigger, pathToExpandAfterDrop, setPathToExpandAfterDrop };
}
