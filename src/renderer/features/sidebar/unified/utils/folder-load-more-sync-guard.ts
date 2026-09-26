/**
 * Synchronous re-entrancy guard for folder "load more" (pagination).
 * React state for `folderLoadingByKey` may not flush before a second call in the same
 * synchronous turn, so a Set updated immediately prevents duplicate in-flight fetches.
 */
export function createFolderLoadMoreSyncGuard() {
  const inFlight = new Set<string>();
  return {
    tryEnter(folderKey: string): boolean {
      if (inFlight.has(folderKey)) return false;
      inFlight.add(folderKey);
      return true;
    },
    exit(folderKey: string): void {
      inFlight.delete(folderKey);
    },
  };
}
