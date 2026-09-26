import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  hasWorkingLineChangesWorktreeInput,
  WORKING_LINE_CHANGES_QUERY_KEY_PREFIX,
} from '../query-keys/changes';

const TRAILING_SLASHES_REGEX = /\/+$/;
const WORKING_LINE_CHANGES_DEBOUNCE_MS = 120;

function normalizePathForPrefixCheck(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(TRAILING_SLASHES_REGEX, '');
}

function isPathInsideWorktree(filePath: string, worktreePath: string): boolean {
  const normalizedFilePath = normalizePathForPrefixCheck(filePath);
  const normalizedWorktreePath = normalizePathForPrefixCheck(worktreePath);
  return (
    normalizedFilePath === normalizedWorktreePath ||
    normalizedFilePath.startsWith(`${normalizedWorktreePath}/`)
  );
}

function invalidateWorkingLineChangesForWorktree(
  queryClient: ReturnType<typeof useQueryClient>,
  worktreePath: string,
) {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const queryKey = query.queryKey;
      if (!Array.isArray(queryKey) || queryKey.length < 2) return false;
      const [pathKey, meta] = queryKey;
      if (!Array.isArray(pathKey)) return false;
      if (
        pathKey[0] !== WORKING_LINE_CHANGES_QUERY_KEY_PREFIX[0] ||
        pathKey[1] !== WORKING_LINE_CHANGES_QUERY_KEY_PREFIX[1]
      ) {
        return false;
      }
      if (!hasWorkingLineChangesWorktreeInput(meta)) return false;
      return meta.input.worktreePath === worktreePath;
    },
  });
}

/**
 * Hook that listens for file changes from Claude Write/Edit tools
 * and invalidates the git status query to trigger a refetch
 */
export function useFileChangeListener(worktreePath: string | null | undefined) {
  const queryClient = useQueryClient();
  const lineChangeDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!worktreePath) return;

    const cleanup = window.desktopApi?.onFileChanged((data) => {
      // Check if the changed file is within our worktree
      if (isPathInsideWorktree(data.filePath, worktreePath)) {
        // Invalidate only this worktree's git status query (not all worktrees)
        queryClient.invalidateQueries({
          queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
        });
        if (lineChangeDebounceRef.current) {
          window.clearTimeout(lineChangeDebounceRef.current);
        }
        lineChangeDebounceRef.current = window.setTimeout(() => {
          invalidateWorkingLineChangesForWorktree(queryClient, worktreePath);
          lineChangeDebounceRef.current = null;
        }, WORKING_LINE_CHANGES_DEBOUNCE_MS);
      }
    });

    return () => {
      cleanup?.();
      if (lineChangeDebounceRef.current) {
        window.clearTimeout(lineChangeDebounceRef.current);
        lineChangeDebounceRef.current = null;
      }
    };
  }, [worktreePath, queryClient]);
}

/**
 * Hook that subscribes to the GitWatcher for real-time file system monitoring.
 * Uses @parcel/watcher on the main process for efficient file watching.
 * Automatically invalidates git status queries when files change.
 */
export function useGitWatcher(
  worktreePath: string | null | undefined,
  /** Runs on every status change of this worktree, e.g. to refresh state kept outside the query cache */
  onStatusChanged?: () => void,
) {
  const queryClient = useQueryClient();
  const onStatusChangedRef = useRef(onStatusChanged);
  // Layout effect: it lands in the same commit, so no event can reach the previous callback
  useLayoutEffect(() => {
    onStatusChangedRef.current = onStatusChanged;
  });
  const lineChangeDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!worktreePath) return;

    // Subscribe to git watcher on main process
    // Per effect run: a subscribe that resolves after unmount is undone at once, never leaked
    let cancelled = false;
    let subscribed = false;
    const subscribe = async () => {
      try {
        await window.desktopApi?.subscribeToGitWatcher(worktreePath);
        if (cancelled) {
          window.desktopApi?.unsubscribeFromGitWatcher(worktreePath).catch((_error) => {});
          return;
        }
        subscribed = true;
      } catch (error) {
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: Development-only diagnostics for watcher subscription failures.
          console.debug('[useGitWatcher] subscribeToGitWatcher failed', {
            worktreePath,
            error,
          });
        }
      }
    };

    subscribe();

    // Listen for git status changes from the watcher (includes .git/HEAD when branch switches)
    const cleanup = window.desktopApi?.onGitStatusChanged((data) => {
      if (data.worktreePath === worktreePath) {
        // Invalidate only this worktree's git status and branch list
        queryClient.invalidateQueries({
          queryKey: [['changes', 'getStatus'], { input: { worktreePath } }],
        });
        queryClient.invalidateQueries({
          queryKey: [['changes', 'getBranches'], { input: { worktreePath } }],
        });
        onStatusChangedRef.current?.();
        if (lineChangeDebounceRef.current) {
          window.clearTimeout(lineChangeDebounceRef.current);
        }
        lineChangeDebounceRef.current = window.setTimeout(() => {
          invalidateWorkingLineChangesForWorktree(queryClient, worktreePath);
          lineChangeDebounceRef.current = null;
        }, WORKING_LINE_CHANGES_DEBOUNCE_MS);
      }
    });

    return () => {
      cleanup?.();
      if (lineChangeDebounceRef.current) {
        window.clearTimeout(lineChangeDebounceRef.current);
        lineChangeDebounceRef.current = null;
      }

      // Unsubscribe from git watcher
      cancelled = true;
      if (subscribed) {
        window.desktopApi?.unsubscribeFromGitWatcher(worktreePath).catch((_error) => {});
      }
    };
  }, [worktreePath, queryClient]);
}
