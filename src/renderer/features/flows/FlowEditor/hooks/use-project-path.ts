import { useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { isProjectRow } from '../is-project-row';

/** Returns the filesystem path for a project by id, or undefined if not found. */
export function useProjectPath(projectId: string): string | undefined {
  const { data: allProjects } = trpc.projects.list.useQuery();
  return useMemo(() => {
    const list = Array.isArray(allProjects) ? allProjects : [];
    const p = list.find((row) => isProjectRow(row) && row.id === projectId);
    // Fall back to undefined if path is empty (e.g. project registered on another machine)
    return p?.path || undefined;
  }, [allProjects, projectId]);
}
