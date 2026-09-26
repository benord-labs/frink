type ShouldSkipSelectedProjectSyncArgs = {
  lastSyncedProjectId: string | null;
  nextProjectId: string | null;
  forceResync: boolean;
};

/**
 * Split->single transitions must run one project re-sync pass even when
 * the project id did not change, otherwise selectedProject can stay stale.
 */
export function shouldSkipSelectedProjectSync({
  lastSyncedProjectId,
  nextProjectId,
  forceResync,
}: ShouldSkipSelectedProjectSyncArgs): boolean {
  if (forceResync) {
    return false;
  }

  return lastSyncedProjectId === nextProjectId;
}
